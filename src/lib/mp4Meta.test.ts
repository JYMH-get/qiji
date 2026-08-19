import { describe, it, expect } from "vitest";
import { parseMp4VideoInfo } from "./mp4Meta";

/** 手工构造 mp4 box：size(u32) + type(4cc) + payload */
function box(type: string, ...payloads: Uint8Array[]): Uint8Array {
	const len = payloads.reduce((s, p) => s + p.length, 0);
	const out = new Uint8Array(8 + len);
	new DataView(out.buffer).setUint32(0, out.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	let off = 8;
	for (const p of payloads) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}
function u32s(...vals: number[]): Uint8Array {
	const out = new Uint8Array(vals.length * 4);
	const dv = new DataView(out.buffer);
	vals.forEach((v, i) => dv.setUint32(i * 4, v));
	return out;
}
function fourcc(s: string): Uint8Array {
	return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

/** mdhd v0：version/flags + creation + modification + timescale + duration */
const mdhd = (timescale: number, duration: number) => box("mdhd", u32s(0, 0, 0, timescale, duration));
/** hdlr：version/flags + pre_defined + handler_type */
const hdlr = (handler: string) => box("hdlr", u32s(0, 0), fourcc(handler), u32s(0, 0, 0));
/** stsz：version/flags + sample_size + sample_count */
const stsz = (count: number) => box("stsz", u32s(0, 0, count));
const trak = (handler: string, timescale: number, duration: number, samples: number) =>
	box("trak", box("mdia", mdhd(timescale, duration), hdlr(handler), box("minf", box("stbl", stsz(samples)))));

describe("parseMp4VideoInfo", () => {
	it("解析视频轨原帧率（跳过前面的音频轨）", () => {
		const bytes = new Uint8Array([
			...box("ftyp", fourcc("isom"), u32s(0)),
			...box("moov", trak("soun", 48000, 96000, 86), trak("vide", 15360, 15360 * 2, 48)),
		]);
		expect(parseMp4VideoInfo(bytes)).toEqual({ fps: 24, frames: 48, durationSec: 2 });
	});
	it("分数帧率保留 3 位小数（29.97）", () => {
		// 30000/1001：timescale 30000，100 帧，duration 100*1001
		const bytes = new Uint8Array([...box("moov", trak("vide", 30000, 100 * 1001, 100))]);
		expect(parseMp4VideoInfo(bytes)!.fps).toBeCloseTo(29.97, 2);
	});
	it("stsz 空时回退 stts 求和", () => {
		// stts：2 个条目（30 帧 + 18 帧）
		const stts = box("stts", u32s(0, 2, 30, 512, 18, 512));
		const t = box("trak", box("mdia", mdhd(15360, 15360), hdlr("vide"), box("minf", box("stbl", stsz(0), stts))));
		const bytes = new Uint8Array([...box("moov", t)]);
		expect(parseMp4VideoInfo(bytes)!.frames).toBe(48);
	});
	it("非 mp4/无 moov/无视频轨/时长为 0 → null", () => {
		expect(parseMp4VideoInfo(new Uint8Array([1, 2, 3]))).toBeNull();
		expect(parseMp4VideoInfo(new Uint8Array([...box("mdat", u32s(0))]))).toBeNull();
		expect(parseMp4VideoInfo(new Uint8Array([...box("moov", trak("soun", 48000, 96000, 86))]))).toBeNull();
		expect(parseMp4VideoInfo(new Uint8Array([...box("moov", trak("vide", 15360, 0, 48))]))).toBeNull();
	});
	it("坏 size 不死循环（size 小于 8 直接终止）", () => {
		const bad = new Uint8Array([0, 0, 0, 3, 109, 111, 111, 118, 0, 0]);
		expect(parseMp4VideoInfo(bad)).toBeNull();
	});
});
