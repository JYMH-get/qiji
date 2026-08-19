import { describe, it, expect } from "vitest";
import { frameCacheKey, thumbTileCount, quantStepFor, planFrameTimes } from "./videoThumb";

describe("frameCacheKey", () => {
	it("按 uri + 两位小数时间点组键", () => {
		expect(frameCacheKey("asset://a.mp4", 1.234)).toBe("asset://a.mp4@1.23");
		expect(frameCacheKey("asset://a.mp4", 0)).toBe("asset://a.mp4@0.00");
	});
	it("不同时间点 / 不同 uri 键不同，同时间点键稳定", () => {
		expect(frameCacheKey("a", 1)).not.toBe(frameCacheKey("a", 2));
		expect(frameCacheKey("a", 1)).not.toBe(frameCacheKey("b", 1));
		expect(frameCacheKey("a", 1.0)).toBe(frameCacheKey("a", 1));
	});
	it("负数时间=自动帧哨兵，单独一个键", () => {
		expect(frameCacheKey("a", -1)).toBe("a@auto");
	});
});

describe("thumbTileCount", () => {
	it("窄片段不抽帧", () => {
		expect(thumbTileCount(0)).toBe(0);
		expect(thumbTileCount(20)).toBe(0);
		expect(thumbTileCount(27.9)).toBe(0);
		expect(thumbTileCount(NaN)).toBe(0);
	});
	it("刚够宽至少一张", () => {
		expect(thumbTileCount(28)).toBe(1);
		expect(thumbTileCount(80)).toBe(1);
		expect(thumbTileCount(119)).toBe(1);
	});
	it("约每 80px 一张", () => {
		expect(thumbTileCount(400)).toBe(5);
		expect(thumbTileCount(800)).toBe(10);
	});
	it("上限 14 张（长片段不失控）", () => {
		expect(thumbTileCount(5000)).toBe(14);
		expect(thumbTileCount(100000)).toBe(14);
	});
});

describe("quantStepFor", () => {
	it("按源时长分三档网格", () => {
		expect(quantStepFor(1.5)).toBe(0.1);
		expect(quantStepFor(2)).toBe(0.1);
		expect(quantStepFor(8)).toBe(0.25);
		expect(quantStepFor(60)).toBe(0.5);
	});
	it("非法时长回退最细档", () => {
		expect(quantStepFor(0)).toBe(0.1);
		expect(quantStepFor(-5)).toBe(0.1);
		expect(quantStepFor(NaN)).toBe(0.1);
	});
});

describe("planFrameTimes", () => {
	it("窄片段返回空数组（不抽帧）", () => {
		expect(planFrameTimes(10, 0, 10)).toEqual([]);
	});
	it("张数与 thumbTileCount 一致", () => {
		expect(planFrameTimes(400, 0, 10)).toHaveLength(thumbTileCount(400));
		expect(planFrameTimes(9000, 0, 100)).toHaveLength(14);
	});
	it("全部落在 source 窗口内且非递减", () => {
		const start = 12.4;
		const dur = 7.6;
		const ts = planFrameTimes(600, start, dur);
		expect(ts.length).toBeGreaterThan(1);
		for (let i = 0; i < ts.length; i++) {
			expect(ts[i]).toBeGreaterThanOrEqual(start);
			expect(ts[i]).toBeLessThan(start + dur);
			if (i > 0) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]);
		}
	});
	it("裁剪过的片段只取窗口内的帧（不从 0 开始）", () => {
		const ts = planFrameTimes(320, 30, 4);
		expect(Math.min(...ts)).toBeGreaterThanOrEqual(30);
		expect(Math.max(...ts)).toBeLessThan(34);
	});
	it("时间点量化到网格：缩放改变张数后仍大量命中已抽过的点", () => {
		const a = new Set(planFrameTimes(800, 0, 60)); // 10 张
		const b = planFrameTimes(1200, 0, 60); // 14 张（同一片段放大）
		const hit = b.filter((t) => a.has(t)).length;
		expect(hit).toBeGreaterThan(0);
		for (const t of b) expect(Math.round((t / quantStepFor(60)) * 1e6) % 1e6).toBe(0);
	});
	it("时长为 0 / 非法时全部退到起点", () => {
		expect(planFrameTimes(400, 5, 0)).toEqual([5, 5, 5, 5, 5]);
		expect(planFrameTimes(160, 3, NaN)).toEqual([3, 3]);
	});
	it("负起点按 0 收敛", () => {
		const ts = planFrameTimes(400, -10, 5);
		for (const t of ts) expect(t).toBeGreaterThanOrEqual(0);
	});
	it("极短片段也不会取到末尾（末帧多数解码器取不到画面）", () => {
		const ts = planFrameTimes(400, 0, 0.4);
		expect(Math.max(...ts)).toBeLessThanOrEqual(0.36);
	});
});
