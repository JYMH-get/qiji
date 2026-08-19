/**
 * videoDepthEncode —— 深度帧序列 → mp4 的编码器封装（WebCodecs VideoEncoder + mp4-muxer）。
 *
 * 纯客户端编码路线（第206轮定稿）：不走 Rust/ffmpeg——项目内置 ffmpeg 只有「单帧/片段」命令，
 * 逐帧抽帧是 O(n²) 重解码；而 WebView2/Chromium 的 WebCodecs 硬编 H.264 一步到位，
 * 浏览器 dev 与打包版同一条代码路径（与转深度「纯客户端零服务端」哲学一致）。
 * ⚠ 只能被动态 import（mp4-muxer 与本模块只在视频转深度时加载）。
 */
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { evenDim } from "@/lib/videoDepthCore";

export interface DepthVideoEncoder {
	/** 输出尺寸（偶数化后的实际编码尺寸；调用方按此尺寸准备画布） */
	width: number;
	height: number;
	/** 编码一帧（index 从 0 起，时间戳=index/fps）。内置背压等待，帧序即调用序。 */
	addFrame(source: CanvasImageSource, index: number): Promise<void>;
	/** 收尾：flush 编码器 + 封装 mp4，返回成品 Blob */
	finish(): Promise<Blob>;
	/** 放弃（节点被删等）：释放编码器，产物丢弃 */
	cancel(): void;
}

/** 按分辨率挑可用的 H.264 编码档（5.1 覆盖到 4K@30；逐档探测，全不支持=明确报错） */
async function pickAvcCodec(width: number, height: number, fps: number, bitrate: number): Promise<string> {
	const candidates = ["avc1.640033", "avc1.4d0033", "avc1.420033"]; // High/Main/Baseline @ L5.1
	for (const codec of candidates) {
		try {
			const sup = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps });
			if (sup.supported) return codec;
		} catch {
			/* 单个档位探测异常继续下一档 */
		}
	}
	throw new Error("当前环境不支持 H.264 视频编码（WebCodecs），无法生成深度视频");
}

/** 创建深度视频编码器（灰度内容压缩友好，码率按像素×帧率取保守值） */
export async function createDepthVideoEncoder(
	srcWidth: number,
	srcHeight: number,
	fps: number,
): Promise<DepthVideoEncoder> {
	if (typeof VideoEncoder === "undefined") {
		throw new Error("当前环境不支持 WebCodecs（VideoEncoder），无法生成深度视频");
	}
	const width = evenDim(srcWidth);
	const height = evenDim(srcHeight);
	// ⚠ 码率给足（0.45 bit/像素/帧，下限 6M）：深度图是大面积平滑渐变，低码率 H.264 会压出
	// 色带/宏块=「精度差」的主观感受（第206轮补充用户反馈实锤，首版 0.15bpp 偏保守勿回退）。
	const bitrate = Math.round(Math.min(30_000_000, Math.max(6_000_000, width * height * fps * 0.45)));
	const codec = await pickAvcCodec(width, height, fps, bitrate);

	const muxer = new Muxer({
		target: new ArrayBufferTarget(),
		video: { codec: "avc", width, height },
		fastStart: "in-memory",
	});
	let encodeError: unknown = null;
	const encoder = new VideoEncoder({
		output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
		error: (e) => {
			encodeError = e;
		},
	});
	encoder.configure({ codec, width, height, bitrate, framerate: fps });

	const frameDurUs = Math.round(1_000_000 / fps);
	const keyEvery = Math.max(1, Math.round(fps * 2)); // 2 秒一个关键帧

	return {
		width,
		height,
		async addFrame(source, index) {
			if (encodeError) throw encodeError instanceof Error ? encodeError : new Error(String(encodeError));
			// 背压：推理远慢于编码，队列通常为空；这里兜底防极端情况内存堆积
			while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 10));
			const frame = new VideoFrame(source, { timestamp: index * frameDurUs, duration: frameDurUs });
			try {
				encoder.encode(frame, { keyFrame: index % keyEvery === 0 });
			} finally {
				frame.close();
			}
		},
		async finish() {
			await encoder.flush();
			if (encodeError) throw encodeError instanceof Error ? encodeError : new Error(String(encodeError));
			encoder.close();
			muxer.finalize();
			const buf = (muxer.target as ArrayBufferTarget).buffer;
			if (!buf || buf.byteLength === 0) throw new Error("深度视频封装失败（空产物）");
			return new Blob([buf], { type: "video/mp4" });
		},
		cancel() {
			try {
				if (encoder.state !== "closed") encoder.close();
			} catch {
				/* 释放失败可忽略 */
			}
		},
	};
}
