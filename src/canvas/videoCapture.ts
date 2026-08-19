/**
 * videoCapture —— 从画布「视频结果」节点的 <video> 元素截取：
 *   - 帧：当前帧 / 首帧 / 尾帧（canvas.drawImage → PNG Blob）
 *   - 尾段：最后 N 秒视频（captureStream + MediaRecorder 实时录制 → webm Blob）
 * 不改动原节点，仅产出 Blob；落库与建新节点由调用方处理。
 * 跨域污染（远程 url 无 CORS）时 drawImage/captureStream 抛错 → 返回 null（调用方提示失败）。
 */

import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";

export type FrameMode = "current" | "first" | "last";
export type CaptureMode = FrameMode | "tail";
export interface Captured {
	blob: Blob;
	ext: string;
	kind: "image" | "video";
}

function isTauri(): boolean {
	return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** ffmpeg 进程可直接读取的源：本地文件路径，或真实 http(s) 直链（排除 webview 内部协议 asset.localhost/ipc.localhost）。 */
function isFfmpegReadable(u?: string | null): boolean {
	return !!u && /^https?:\/\//i.test(u) && !/asset\.localhost|ipc\.localhost/i.test(u);
}

/**
 * 解析一个视频节点的源：
 *  - direct：ffmpeg 可直接读的源（本地原件路径 或 真实 http(s) 直链），有则最快。
 *  - fetchUri：可在 webview 内 fetch 到字节的 uri（asset:// / http://asset.localhost / 直链），
 *    当 direct 为空（仅 webview 内部协议）时，先 fetch 落临时文件再喂 ffmpeg。
 */
function resolveVideoSourceInfo(nodeId: string): { direct?: string; fetchUri?: string } {
	const node = useCanvasStore.getState().nodes[nodeId];
	const assetId = node?.data.resultAssetId;
	if (!assetId) return {};
	const asset = useLibraryStore.getState().assets[assetId];
	const blobs = useProjectStore.getState().assetBlobs;
	const blob = (asset?.serverAssetId ? blobs[asset.serverAssetId] : undefined) ?? blobs[assetId];
	const localPath = asset?.localPath || blob?.localPath || undefined;
	const direct = localPath || [blob?.url, asset?.uri, blob?.localUri].find(isFfmpegReadable) || undefined;
	const fetchUri = asset?.uri || blob?.localUri || blob?.url || undefined;
	return { direct, fetchUri };
}

/**
 * 原生(ffmpeg)截取：本地原件/真实直链直接喂 ffmpeg；仅 webview 内部协议(asset://)时先 fetch 字节落临时输入文件。
 * 帧 → PNG、尾段 → mp4。非 Tauri 或取不到源时返回 null（调用方回退浏览器 JS 截取）。
 */
export async function captureNative(
	nodeId: string,
	mode: CaptureMode,
	currentTime: number,
	duration: number,
	tailSeconds = 4,
): Promise<Captured | null> {
	if (!isTauri()) return null;
	const { direct, fetchUri } = resolveVideoSourceInfo(nodeId);
	if (!direct && !fetchUri) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	const fs = await import("@tauri-apps/plugin-fs");
	const path = await import("@tauri-apps/api/path");

	// 准备 ffmpeg 输入：能直读就直读；否则 fetch 字节落临时文件
	let input = direct ?? "";
	let tempInput = "";
	if (!input) {
		const resp = await fetch(fetchUri as string);
		if (!resp.ok) throw new Error(`读取视频源失败（HTTP ${resp.status}）`);
		const bytes = new Uint8Array(await resp.arrayBuffer());
		const dir = await path.tempDir();
		tempInput = await path.join(dir, `qiji-capin-${Date.now()}.mp4`);
		await fs.writeFile(tempInput, bytes);
		input = tempInput;
	}

	try {
		let outPath: string;
		let ext: string;
		let kind: "image" | "video";
		let mime: string;
		// 时间值兜底为有限、在时长内（duration 可能是 Infinity/NaN：流式/缺 metadata 时）
		const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
		const cur = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
		if (mode === "tail") {
			const start = dur ? Math.max(0, dur - tailSeconds) : 0;
			const len = dur ? Math.min(tailSeconds, dur) : tailSeconds;
			outPath = await invoke<string>("extract_video_clip", { src: input, startSec: start, durSec: len });
			ext = "mp4";
			kind = "video";
			mime = "video/mp4";
		} else {
			const safeEnd = dur ? Math.max(0, dur - 0.1) : cur;
			const t =
				mode === "first" ? 0 : mode === "last" ? safeEnd : dur ? Math.min(cur, safeEnd) : cur;
			outPath = await invoke<string>("extract_video_frame", { src: input, timeSec: Math.max(0, t) });
			ext = "png";
			kind = "image";
			mime = "image/png";
		}
		const bytes = await fs.readFile(outPath);
		try {
			await fs.remove(outPath);
		} catch {
			/* 临时输出清理失败可忽略 */
		}
		if (!bytes || bytes.length === 0) return null;
		return { blob: new Blob([bytes], { type: mime }), ext, kind };
	} finally {
		if (tempInput) {
			try {
				await fs.remove(tempInput);
			} catch {
				/* 临时输入清理失败可忽略 */
			}
		}
	}
}

/**
 * 由 uri 解析 ffmpeg 源（供「视频界面」分镜表格用，不经画布节点）：
 *  - direct：本地原件路径 或 真实 http(s) 直链（ffmpeg 可直读）。
 *  - fetchUri：webview 内可 fetch 的 uri（asset:// / asset.localhost），direct 缺失时先落临时文件。
 */
function resolveUriSourceInfo(uri: string): { direct?: string; fetchUri?: string } {
	const blob = useProjectStore.getState().blobByUri(uri);
	const localPath = blob?.localPath || undefined;
	const direct = localPath || [blob?.url, uri, blob?.localUri].find(isFfmpegReadable) || undefined;
	const fetchUri = uri || blob?.localUri || blob?.url || undefined;
	return { direct, fetchUri };
}

/** 用 metadata-only 加载探测视频时长（秒）；失败/超时回 0。不解码、不污染画布。 */
export function probeVideoDuration(uri: string): Promise<number> {
	return new Promise<number>((resolve) => {
		const v = document.createElement("video");
		v.preload = "metadata"; v.muted = true;
		let done = false;
		const finish = (d: number) => { if (done) return; done = true; v.removeAttribute("src"); resolve(Number.isFinite(d) && d > 0 ? d : 0); };
		v.onloadedmetadata = () => finish(v.duration);
		v.onerror = () => finish(0);
		setTimeout(() => finish(v.duration), 3000);
		v.src = uri;
	});
}

/**
 * 原生(ffmpeg)从 uri 截取：帧 → PNG，片段 → mp4（真·重编码裁剪，非实时录制）。
 * 本地原件/真实直链直接喂 ffmpeg；仅 asset:// 时先 fetch 字节落临时文件。
 * 非 Tauri 或取不到源返回 null（调用方回退浏览器 JS 截取）。
 */
export async function captureFromUri(
	uri: string,
	mode: "frame" | "clip",
	opts: { timeSec?: number; startSec?: number; endSec?: number },
): Promise<Captured | null> {
	if (!isTauri() || !uri) return null;
	const { direct, fetchUri } = resolveUriSourceInfo(uri);
	if (!direct && !fetchUri) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	const fs = await import("@tauri-apps/plugin-fs");
	const path = await import("@tauri-apps/api/path");

	let input = direct ?? "";
	let tempInput = "";
	if (!input) {
		const resp = await fetch(fetchUri as string);
		if (!resp.ok) throw new Error(`读取视频源失败（HTTP ${resp.status}）`);
		const bytes = new Uint8Array(await resp.arrayBuffer());
		const dir = await path.tempDir();
		tempInput = await path.join(dir, `qiji-capin-${Date.now()}.mp4`);
		await fs.writeFile(tempInput, bytes);
		input = tempInput;
	}
	try {
		let outPath: string, ext: string, kind: "image" | "video", mime: string;
		if (mode === "clip") {
			const start = Math.max(0, opts.startSec ?? 0);
			const len = Math.max(0.1, (opts.endSec ?? 0) - start);
			outPath = await invoke<string>("extract_video_clip", { src: input, startSec: start, durSec: len });
			ext = "mp4"; kind = "video"; mime = "video/mp4";
		} else {
			outPath = await invoke<string>("extract_video_frame", { src: input, timeSec: Math.max(0, opts.timeSec ?? 0) });
			ext = "png"; kind = "image"; mime = "image/png";
		}
		const bytes = await fs.readFile(outPath);
		try { await fs.remove(outPath); } catch { /* 临时输出清理失败可忽略 */ }
		if (!bytes || bytes.length === 0) return null;
		return { blob: new Blob([bytes], { type: mime }), ext, kind };
	} finally {
		if (tempInput) { try { await fs.remove(tempInput); } catch { /* 清理失败可忽略 */ } }
	}
}

/** 跳转到指定时间并等待 seeked（带兜底超时，避免 metadata 缺失时卡死）。 */
function waitSeek(v: HTMLVideoElement, t: number): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			v.removeEventListener("seeked", finish);
			resolve();
		};
		v.addEventListener("seeked", finish);
		setTimeout(finish, 1500);
		try {
			const dur = v.duration || 0;
			v.currentTime = Math.max(0, dur ? Math.min(t, dur - 0.01) : t);
		} catch {
			finish();
		}
	});
}

/** 截取一帧为 PNG Blob。current=当前播放位置；first=0；last=结尾。完成后还原播放位置/状态。 */
export async function grabFrame(v: HTMLVideoElement, mode: FrameMode): Promise<Blob | null> {
	const dur = v.duration || 0;
	const prev = v.currentTime;
	const wasPaused = v.paused;
	v.pause();
	const target = mode === "first" ? 0 : mode === "last" ? Math.max(0, dur - 0.05) : prev;
	if (mode !== "current") await waitSeek(v, target);
	const canvas = document.createElement("canvas");
	canvas.width = v.videoWidth || 1280;
	canvas.height = v.videoHeight || 720;
	const ctx = canvas.getContext("2d");
	let blob: Blob | null = null;
	if (ctx) {
		try {
			ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
			blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/png"));
		} catch {
			blob = null; // 跨域污染
		}
	}
	// 还原
	if (mode !== "current") {
		try {
			v.currentTime = prev;
		} catch {
			/* ignore */
		}
	}
	if (!wasPaused) v.play().catch(() => {});
	return blob;
}

/** 录制最后 seconds 秒为 webm Blob（实时播放该段）。无 captureStream/MediaRecorder 或跨域时返回 null。 */
export async function grabTailClip(v: HTMLVideoElement, seconds: number): Promise<Blob | null> {
	const dur = v.duration || 0;
	if (!dur) return null;
	const capture = (v as unknown as { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream });
	let stream: MediaStream | null = null;
	try {
		stream = capture.captureStream?.() ?? capture.mozCaptureStream?.() ?? null;
	} catch {
		stream = null;
	}
	if (!stream || typeof MediaRecorder === "undefined") return null;

	const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
		? "video/webm;codecs=vp9"
		: MediaRecorder.isTypeSupported("video/webm")
			? "video/webm"
			: "";
	let rec: MediaRecorder;
	try {
		rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
	} catch {
		return null;
	}

	const chunks: BlobPart[] = [];
	rec.ondataavailable = (e) => {
		if (e.data && e.data.size) chunks.push(e.data);
	};

	const wasPaused = v.paused;
	const prev = v.currentTime;
	const start = Math.max(0, dur - seconds);
	await waitSeek(v, start);

	return await new Promise<Blob | null>((resolve) => {
		let settled = false;
		const stopRec = () => {
			if (rec.state !== "inactive") {
				try {
					rec.stop();
				} catch {
					/* ignore */
				}
			}
		};
		const onTime = () => {
			if (v.currentTime >= dur - 0.08) {
				v.removeEventListener("timeupdate", onTime);
				stopRec();
			}
		};
		rec.onstop = () => {
			if (settled) return;
			settled = true;
			v.removeEventListener("timeupdate", onTime);
			v.pause();
			try {
				v.currentTime = prev;
			} catch {
				/* ignore */
			}
			if (!wasPaused) v.play().catch(() => {});
			resolve(chunks.length ? new Blob(chunks, { type: mime || "video/webm" }) : null);
		};
		v.addEventListener("timeupdate", onTime);
		try {
			rec.start();
		} catch {
			resolve(null);
			return;
		}
		v.play().catch(() => stopRec());
		// 安全兜底：最多录 seconds+2 秒
		setTimeout(stopRec, (seconds + 2) * 1000);
	});
}
