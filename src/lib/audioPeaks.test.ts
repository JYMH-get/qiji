import { describe, it, expect } from "vitest";
import { peakCacheKey, barsForWidth, resamplePeaks, pseudoPeaks, WAVE_BUCKETS } from "./audioPeaks";

describe("peakCacheKey", () => {
	it("键带桶数：同一 uri 不同桶数互不覆盖", () => {
		expect(peakCacheKey("asset://a.mp3", 48)).toBe("asset://a.mp3@48");
		expect(peakCacheKey("asset://a.mp3", 48)).not.toBe(peakCacheKey("asset://a.mp3", 256));
	});
	it("不同 uri 同桶数键不同", () => {
		expect(peakCacheKey("a", 64)).not.toBe(peakCacheKey("b", 64));
	});
});

describe("barsForWidth", () => {
	it("约每 3px 一根", () => {
		expect(barsForWidth(300)).toBe(100);
		expect(barsForWidth(600)).toBe(200);
	});
	it("收敛到 48..256", () => {
		expect(barsForWidth(10)).toBe(48);
		expect(barsForWidth(143)).toBe(48);
		expect(barsForWidth(5000)).toBe(256);
	});
	it("非法宽度回退最小桶数", () => {
		expect(barsForWidth(0)).toBe(48);
		expect(barsForWidth(-5)).toBe(48);
		expect(barsForWidth(NaN)).toBe(48);
	});
});

describe("resamplePeaks", () => {
	const src = Array.from({ length: 256 }, (_, i) => (i % 8) / 8);
	it("降采样到目标桶数", () => {
		expect(resamplePeaks(src, 64)).toHaveLength(64);
		expect(resamplePeaks(src, 48)).toHaveLength(48);
	});
	it("取每段最大值（保住轮廓，不抹平尖峰）", () => {
		expect(resamplePeaks([0, 1, 0, 0], 2)).toEqual([1, 0]);
	});
	it("目标桶数 ≥ 源桶数时原样返回（不造不存在的细节）", () => {
		expect(resamplePeaks(src, 256)).toBe(src);
		expect(resamplePeaks(src, 999)).toBe(src);
	});
	it("空数组/非法桶数不炸", () => {
		expect(resamplePeaks([], 48)).toEqual([]);
		expect(resamplePeaks(src, 0)).toBe(src);
		expect(resamplePeaks(src, NaN)).toBe(src);
	});
	it("值域仍在 0..1", () => {
		for (const v of resamplePeaks(src, 50)) {
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});
});

describe("pseudoPeaks", () => {
	it("同 uri 恒同形、不同 uri 不同形", () => {
		expect(pseudoPeaks("a.mp4", 32)).toEqual(pseudoPeaks("a.mp4", 32));
		expect(pseudoPeaks("a.mp4", 32)).not.toEqual(pseudoPeaks("b.mp4", 32));
	});
	it("按请求桶数产出，值域 0..1", () => {
		const p = pseudoPeaks("x", WAVE_BUCKETS);
		expect(p).toHaveLength(WAVE_BUCKETS);
		for (const v of p) {
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});
});
