/**
 * 音频时长解析（纯函数零依赖，服务端版）。
 *
 * 奇迹云 H3 工作流的 LoadAudioUI 节点要求显式 end_time/duration（骨架样例即写死的秒数）——
 * 派单前从下载到手的音频字节里解出真实时长填入。覆盖 WAV / MP3 / MP4(M4A) 三族；
 * 解析不出返回 null（调用方兜底），坏字节绝不 throw（全程防越界读）。
 * 箱解析思路参考客户端 src/lib/mp4Meta.ts（服务端独立实现，勿互相 import——两端各自打包）。
 */

/** WAV：RIFF/WAVE → fmt 的 byteRate + data 的 size */
function wavDuration(dv: DataView): number | null {
	if (dv.byteLength < 44) return null;
	if (str4(dv, 0) !== "RIFF" || str4(dv, 8) !== "WAVE") return null;
	let byteRate = 0;
	let dataSize = 0;
	let p = 12;
	while (p + 8 <= dv.byteLength) {
		const id = str4(dv, p);
		const size = dv.getUint32(p + 4, true);
		if (size > dv.byteLength) return null; // 坏 size 防死循环
		if (id === "fmt " && p + 8 + 16 <= dv.byteLength) {
			byteRate = dv.getUint32(p + 16, true); // fmt payload +8（format2+channels2+sampleRate4 之后）
		} else if (id === "data") {
			dataSize = size;
		}
		p += 8 + size + (size % 2); // chunk 按 2 字节对齐
	}
	if (!byteRate || !dataSize) return null;
	const sec = dataSize / byteRate;
	return Number.isFinite(sec) && sec > 0 ? sec : null;
}

// ── MP3（Layer3）：位率/采样率表 + Xing/Info 帧数优先、CBR 估算兜底 ──
const MP3_BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_SAMPLERATE: Record<number, number[]> = {
	3: [44100, 48000, 32000], // MPEG1
	2: [22050, 24000, 16000], // MPEG2
	0: [11025, 12000, 8000], // MPEG2.5
};

function mp3Duration(dv: DataView): number | null {
	let p = 0;
	// 跳 ID3v2（size=syncsafe 4 字节）
	if (dv.byteLength > 10 && str4(dv, 0).startsWith("ID3")) {
		const size =
			((dv.getUint8(6) & 0x7f) << 21) | ((dv.getUint8(7) & 0x7f) << 14) | ((dv.getUint8(8) & 0x7f) << 7) | (dv.getUint8(9) & 0x7f);
		p = 10 + size;
	}
	// 找首帧同步字（容忍标签后少量垫片，最多扫 64KB）
	const scanEnd = Math.min(dv.byteLength - 4, p + 65536);
	let frameAt = -1;
	for (; p <= scanEnd; p++) {
		if (dv.getUint8(p) === 0xff && (dv.getUint8(p + 1) & 0xe0) === 0xe0) {
			frameAt = p;
			break;
		}
	}
	if (frameAt < 0 || frameAt + 4 > dv.byteLength) return null;
	const b1 = dv.getUint8(frameAt + 1);
	const b2 = dv.getUint8(frameAt + 2);
	const b3 = dv.getUint8(frameAt + 3);
	const versionBits = (b1 >> 3) & 3; // 3=MPEG1 2=MPEG2 0=MPEG2.5
	const layerBits = (b1 >> 1) & 3; // 1=Layer3
	if (versionBits === 1 || layerBits !== 1) return null;
	const bitrateIdx = (b2 >> 4) & 15;
	const sampleIdx = (b2 >> 2) & 3;
	if (bitrateIdx === 0 || bitrateIdx === 15 || sampleIdx === 3) return null;
	const isV1 = versionBits === 3;
	const bitrateKbps = (isV1 ? MP3_BITRATE_V1 : MP3_BITRATE_V2)[bitrateIdx];
	const sampleRate = MP3_SAMPLERATE[versionBits]?.[sampleIdx];
	if (!bitrateKbps || !sampleRate) return null;
	const samplesPerFrame = isV1 ? 1152 : 576;

	// Xing/Info 头（VBR 精确帧数）：偏移随 版本×声道 变化
	const mono = ((b3 >> 6) & 3) === 3;
	const sideInfo = isV1 ? (mono ? 17 : 32) : mono ? 9 : 17;
	const xingAt = frameAt + 4 + sideInfo;
	if (xingAt + 12 <= dv.byteLength) {
		const tag = str4(dv, xingAt);
		if (tag === "Xing" || tag === "Info") {
			const flags = dv.getUint32(xingAt + 4);
			if (flags & 1) {
				const frames = dv.getUint32(xingAt + 8);
				if (frames > 0) {
					const sec = (frames * samplesPerFrame) / sampleRate;
					return Number.isFinite(sec) && sec > 0 ? sec : null;
				}
			}
		}
	}
	// CBR 估算：(音频段字节数×8) / 位率
	const sec = ((dv.byteLength - frameAt) * 8) / (bitrateKbps * 1000);
	return Number.isFinite(sec) && sec > 0 ? sec : null;
}

// ── MP4/M4A：moov > mvhd 的 timescale/duration（version 0/1 两形态）──
interface Box {
	type: string;
	start: number;
	end: number;
}

function* boxes(dv: DataView, start: number, end: number): Generator<Box> {
	let p = start;
	while (p + 8 <= end) {
		const size32 = dv.getUint32(p);
		const type = str4(dv, p + 4);
		let payload = p + 8;
		let boxEnd: number;
		if (size32 === 0) {
			boxEnd = end;
		} else if (size32 === 1) {
			if (p + 16 > end) return;
			boxEnd = p + dv.getUint32(p + 8) * 0x100000000 + dv.getUint32(p + 12);
			payload = p + 16;
		} else {
			boxEnd = p + size32;
		}
		if (size32 !== 0 && size32 !== 1 && size32 < 8) return; // 坏 size：终止防死循环
		if (boxEnd > end || boxEnd <= p) return;
		yield { type, start: payload, end: boxEnd };
		p = boxEnd;
	}
}

function mp4Duration(dv: DataView): number | null {
	let moov: Box | null = null;
	for (const b of boxes(dv, 0, dv.byteLength)) if (b.type === "moov") moov = b;
	if (!moov) return null;
	for (const b of boxes(dv, moov.start, moov.end)) {
		if (b.type !== "mvhd") continue;
		if (b.start + 4 > b.end) return null;
		const version = dv.getUint8(b.start);
		if (version === 0) {
			if (b.start + 20 > b.end) return null;
			const timescale = dv.getUint32(b.start + 12);
			const duration = dv.getUint32(b.start + 16);
			if (!timescale || !duration) return null;
			return duration / timescale;
		}
		if (version === 1) {
			if (b.start + 32 > b.end) return null;
			const timescale = dv.getUint32(b.start + 20);
			const duration = dv.getUint32(b.start + 24) * 0x100000000 + dv.getUint32(b.start + 28);
			if (!timescale || !duration) return null;
			return duration / timescale;
		}
		return null;
	}
	return null;
}

function str4(dv: DataView, at: number): string {
	if (at + 4 > dv.byteLength) return "";
	return String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));
}

/**
 * 解析音频字节的时长（秒）。hint=文件名/扩展名提示（只影响尝试顺序，不作硬判据——
 * 素材 URL 的扩展名与真实格式经常不符）。解析不出返回 null。
 */
export function audioDurationSec(bytes: Buffer, hint?: string): number | null {
	if (!bytes || bytes.length < 12) return null;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const h = (hint ?? "").toLowerCase();
	const tryOrder: Array<(d: DataView) => number | null> =
		/\.(m4a|mp4|aac|mov)(\?|$)/.test(h) ? [mp4Duration, mp3Duration, wavDuration]
		: /\.wav(\?|$)/.test(h) ? [wavDuration, mp3Duration, mp4Duration]
		: [wavDuration, mp4Duration, mp3Duration]; // 缺省：魔数强判据（RIFF/ftyp）在前，MP3 同步字扫描最宽松放最后
	for (const fn of tryOrder) {
		try {
			const sec = fn(dv);
			if (sec !== null && Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000) / 1000;
		} catch {
			/* 坏字节绝不 throw：换下一个解析器 */
		}
	}
	return null;
}
