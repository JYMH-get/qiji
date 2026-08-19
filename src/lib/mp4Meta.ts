/**
 * mp4Meta —— 从 mp4/mov 容器字节里解析视频轨的**原始帧率**（纯函数零依赖，可单测）。
 *
 * 视频转深度「不抽帧、按原帧率逐帧」（第206轮补充用户定稿）需要知道源视频真实 fps，
 * 而 <video> 元素不暴露帧率——从容器 moov 直接算：
 *   fps = 视频轨采样数（stsz/stts） ÷ 轨时长（mdhd duration/timescale）。
 * 解析目标只有 moov>trak>mdia 的 mdhd/hdlr/stbl 三件，其余 box 全部跳过；
 * 任何形状不对（webm、碎片化 mp4、损坏文件）返回 null 由调用方走回退帧率。
 */

export interface Mp4VideoInfo {
	/** 原始帧率（采样数/时长；VFR 源为平均帧率） */
	fps: number;
	/** 视频轨采样（帧）数 */
	frames: number;
	/** 视频轨时长（秒） */
	durationSec: number;
}

interface Box {
	type: string;
	start: number; // payload 起点
	end: number; // payload 终点（不含）
}

/** 迭代 [start,end) 区间内的同级 box（size=1 的 64 位 largesize 支持；size=0=到区间末尾） */
function* boxes(dv: DataView, start: number, end: number): Generator<Box> {
	let p = start;
	while (p + 8 <= end) {
		const size32 = dv.getUint32(p);
		const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
		let payload = p + 8;
		let boxEnd: number;
		if (size32 === 0) {
			boxEnd = end;
		} else if (size32 === 1) {
			if (p + 16 > end) return;
			const hi = dv.getUint32(p + 8);
			const lo = dv.getUint32(p + 12);
			const size = hi * 0x100000000 + lo;
			payload = p + 16;
			boxEnd = p + size;
		} else {
			boxEnd = p + size32;
		}
		if (size32 !== 0 && size32 !== 1 && size32 < 8) return; // 坏 size：终止防死循环
		if (boxEnd > end || boxEnd <= p) return;
		yield { type, start: payload, end: boxEnd };
		p = boxEnd;
	}
}

function findChild(dv: DataView, parent: Box, type: string): Box | null {
	for (const b of boxes(dv, parent.start, parent.end)) if (b.type === type) return b;
	return null;
}

/** mdhd → { timescale, duration }（version 0/1 两形态） */
function readMdhd(dv: DataView, mdhd: Box): { timescale: number; duration: number } | null {
	if (mdhd.start + 4 > mdhd.end) return null;
	const version = dv.getUint8(mdhd.start);
	if (version === 0) {
		if (mdhd.start + 20 > mdhd.end) return null;
		return { timescale: dv.getUint32(mdhd.start + 12), duration: dv.getUint32(mdhd.start + 16) };
	}
	if (version === 1) {
		if (mdhd.start + 32 > mdhd.end) return null;
		const timescale = dv.getUint32(mdhd.start + 20);
		const hi = dv.getUint32(mdhd.start + 24);
		const lo = dv.getUint32(mdhd.start + 28);
		return { timescale, duration: hi * 0x100000000 + lo };
	}
	return null;
}

/** stsz（或 stts 求和兜底）→ 采样数 */
function readSampleCount(dv: DataView, stbl: Box): number {
	const stsz = findChild(dv, stbl, "stsz");
	if (stsz && stsz.start + 12 <= stsz.end) {
		const n = dv.getUint32(stsz.start + 8);
		if (n > 0) return n;
	}
	const stts = findChild(dv, stbl, "stts");
	if (stts && stts.start + 8 <= stts.end) {
		const entries = dv.getUint32(stts.start + 4);
		let total = 0;
		for (let i = 0; i < entries; i++) {
			const off = stts.start + 8 + i * 8;
			if (off + 8 > stts.end) break;
			total += dv.getUint32(off);
		}
		return total;
	}
	return 0;
}

/**
 * 解析 mp4 视频轨帧率。形状不对/找不到视频轨/时长为 0（碎片化 mp4 等）→ null。
 * fps 保留 3 位小数（29.97 类分数帧率不失真）。
 */
export function parseMp4VideoInfo(bytes: Uint8Array): Mp4VideoInfo | null {
	if (!bytes || bytes.length < 16) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const root: Box = { type: "", start: 0, end: bytes.byteLength };
	const moov = findChild(dv, root, "moov");
	if (!moov) return null;
	for (const trak of boxes(dv, moov.start, moov.end)) {
		if (trak.type !== "trak") continue;
		const mdia = findChild(dv, trak, "mdia");
		if (!mdia) continue;
		const hdlr = findChild(dv, mdia, "hdlr");
		// handler_type 位于 hdlr payload +8（version/flags 4 + pre_defined 4）
		if (!hdlr || hdlr.start + 12 > hdlr.end) continue;
		const handler = String.fromCharCode(
			dv.getUint8(hdlr.start + 8),
			dv.getUint8(hdlr.start + 9),
			dv.getUint8(hdlr.start + 10),
			dv.getUint8(hdlr.start + 11),
		);
		if (handler !== "vide") continue;
		const mdhd = findChild(dv, mdia, "mdhd");
		const timing = mdhd ? readMdhd(dv, mdhd) : null;
		if (!timing || !timing.timescale || !timing.duration) return null;
		const minf = findChild(dv, mdia, "minf");
		const stbl = minf ? findChild(dv, minf, "stbl") : null;
		const frames = stbl ? readSampleCount(dv, stbl) : 0;
		if (!frames) return null;
		const durationSec = timing.duration / timing.timescale;
		const fps = Math.round((frames / durationSec) * 1000) / 1000;
		if (!Number.isFinite(fps) || fps <= 0) return null;
		return { fps, frames, durationSec };
	}
	return null;
}
