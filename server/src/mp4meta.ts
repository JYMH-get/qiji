/**
 * MP4/MOV（ISO BMFF）时长元数据解析（第140轮，参考视频按秒计费用）。
 *
 * 零依赖、不用 ffmpeg：时长在 moov→mvhd（timescale + duration）。两种取法：
 *  - parseMp4DurationMs(buf)：字节已在手（上传入库时）——直接走查顶层 box。
 *  - probeRemoteDurationMs(url)：远端文件（OSS 直链）——HTTP Range 逐个顶层 box 走查
 *    （每步只拉 16 字节 header），找到 moov 再拉该 box 解析。moov 在文件尾（非 faststart）
 *    也能处理；实测 rains3 支持 Range，13MB 视频 5 次请求 ~16KB 即出时长。
 * 解析不出（非 ISO BMFF 容器如 webm / 损坏 / 网络失败）一律返回 null，由调用方决定拒单。
 */

interface BoxHeader {
	type: string;
	size: number; // Infinity = box 延伸到文件尾（size32=0）
	headerLen: number;
}

function readBox(buf: Buffer, off: number): BoxHeader | null {
	if (off + 8 > buf.length) return null;
	const size32 = buf.readUInt32BE(off);
	const type = buf.toString("latin1", off + 4, off + 8);
	if (size32 === 1) {
		if (off + 16 > buf.length) return null;
		return { type, size: Number(buf.readBigUInt64BE(off + 8)), headerLen: 16 };
	}
	return { type, size: size32 === 0 ? Infinity : size32, headerLen: 8 };
}

/** 在完整 moov box 字节里找 mvhd → 毫秒时长（解析不出 null） */
function parseMvhdMs(moov: Buffer): number | null {
	let off = 8; // 跳过 moov 自身 header（传入的 moov 恒为 size32 形态起头也兼容：readBox 决定 headerLen）
	const head = readBox(moov, 0);
	if (head) off = head.headerLen;
	let guard = 0;
	while (off + 8 <= moov.length && guard++ < 64) {
		const b = readBox(moov, off);
		if (!b || b.size < b.headerLen) return null;
		if (b.type === "mvhd") {
			const p = off + b.headerLen;
			if (p + 4 > moov.length) return null;
			const version = moov.readUInt8(p);
			let timescale: number;
			let duration: number;
			if (version === 1) {
				// fullbox(4) + creation(8) + modification(8) + timescale(4) + duration(8)
				if (p + 4 + 16 + 4 + 8 > moov.length) return null;
				timescale = moov.readUInt32BE(p + 4 + 16);
				duration = Number(moov.readBigUInt64BE(p + 4 + 16 + 4));
			} else {
				// fullbox(4) + creation(4) + modification(4) + timescale(4) + duration(4)
				if (p + 4 + 8 + 4 + 4 > moov.length) return null;
				timescale = moov.readUInt32BE(p + 4 + 8);
				duration = moov.readUInt32BE(p + 4 + 8 + 4);
				if (duration === 0xffffffff) return null; // v0 约定：全 1 = 时长未知
			}
			if (!timescale || !Number.isFinite(duration) || duration <= 0) return null;
			return Math.round((duration / timescale) * 1000);
		}
		if (!Number.isFinite(b.size)) return null;
		off += b.size;
	}
	return null;
}

/** 字节在手：顶层 box 走查找 moov → mvhd 毫秒时长（非 ISO BMFF/解析失败 null） */
export function parseMp4DurationMs(buf: Buffer): number | null {
	let off = 0;
	let guard = 0;
	while (off + 8 <= buf.length && guard++ < 64) {
		const b = readBox(buf, off);
		if (!b || b.size < b.headerLen) return null;
		if (b.type === "moov") {
			const end = Number.isFinite(b.size) ? Math.min(off + b.size, buf.length) : buf.length;
			return parseMvhdMs(buf.subarray(off, end));
		}
		if (!Number.isFinite(b.size)) return null;
		off += b.size;
	}
	return null;
}

const MOOV_MAX = 16 * 1024 * 1024; // moov 上限（15s 级素材通常 <100KB；防异常文件拉爆内存）
const FULL_MAX = 64 * 1024 * 1024; // 服务器不支持 Range 时整体兜底解析的体积上限

/**
 * 远端文件时长探测（HTTP Range 顶层 box 走查）。fetchImpl 可注入（冒烟测试用）。
 * 任何失败（网络/不支持 Range 且过大/解析不出）→ null，不抛异常。
 */
export async function probeRemoteDurationMs(url: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
	try {
		const rangeGet = async (start: number, end: number): Promise<{ buf: Buffer; full: boolean; total: number }> => {
			const r = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(20000) });
			if (r.status === 206) {
				// Content-Range: bytes 0-15/13637817 → 总大小
				const cr = r.headers.get("content-range") || "";
				const total = Number(cr.split("/")[1]) || 0;
				return { buf: Buffer.from(await r.arrayBuffer()), full: false, total };
			}
			if (r.status === 200) {
				// 不支持 Range：整体返回（受 FULL_MAX 保护）
				const len = Number(r.headers.get("content-length")) || 0;
				if (len > FULL_MAX) throw new Error("文件过大且服务器不支持 Range");
				return { buf: Buffer.from(await r.arrayBuffer()), full: true, total: len };
			}
			throw new Error(`HTTP ${r.status}`);
		};

		const first = await rangeGet(0, 15);
		if (first.full) return parseMp4DurationMs(first.buf);

		const total = first.total;
		if (!total) return null;
		let off = 0;
		let hdr: Buffer | null = first.buf;
		let guard = 0;
		while (off < total && guard++ < 64) {
			if (!hdr) hdr = (await rangeGet(off, Math.min(off + 15, total - 1))).buf;
			const b = readBox(hdr, 0);
			hdr = null;
			if (!b || b.size < b.headerLen) return null;
			if (b.type === "moov") {
				const size = Number.isFinite(b.size) ? Math.min(b.size, MOOV_MAX) : Math.min(total - off, MOOV_MAX);
				const moov = (await rangeGet(off, Math.min(off + size - 1, total - 1))).buf;
				return parseMvhdMs(moov);
			}
			if (!Number.isFinite(b.size)) return null;
			off += b.size;
		}
		return null;
	} catch {
		return null;
	}
}
