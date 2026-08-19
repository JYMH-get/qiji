import { describe, expect, it } from "vitest";
import {
	DEFAULT_ASPECT_ID,
	DEFAULT_RESOLUTION_ID,
	RTC_ASPECTS,
	RTC_RESOLUTIONS,
	aspectRatioOf,
	canvasSizeOf,
	formatCanvasLabel,
	makeEven,
	resolveCanvasPreset,
	sameCanvas,
} from "./rtcCanvasSpec";

describe("rtcCanvasSpec · 档位表", () => {
	it("比例档 6 项、分辨率档 4 项，id 唯一", () => {
		expect(RTC_ASPECTS.map((a) => a.id)).toEqual(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
		expect(RTC_RESOLUTIONS.map((r) => r.id)).toEqual(["720P", "1080P", "2K", "4K"]);
		expect(new Set(RTC_ASPECTS.map((a) => a.id)).size).toBe(RTC_ASPECTS.length);
	});

	it("默认档 = 1920×1080（与 DEFAULT_RTC_CANVAS 一致）", () => {
		expect(canvasSizeOf(DEFAULT_ASPECT_ID, DEFAULT_RESOLUTION_ID)).toEqual({ width: 1920, height: 1080 });
	});
});

describe("rtcCanvasSpec · canvasSizeOf 像素换算", () => {
	it("16:9 各档落在业界标准值上", () => {
		expect(canvasSizeOf("16:9", "720P")).toEqual({ width: 1280, height: 720 });
		expect(canvasSizeOf("16:9", "1080P")).toEqual({ width: 1920, height: 1080 });
		expect(canvasSizeOf("16:9", "2K")).toEqual({ width: 2560, height: 1440 });
		expect(canvasSizeOf("16:9", "4K")).toEqual({ width: 3840, height: 2160 });
	});

	it("竖屏 = 横屏转置（短边恒为分辨率基准）", () => {
		expect(canvasSizeOf("9:16", "1080P")).toEqual({ width: 1080, height: 1920 });
		expect(canvasSizeOf("3:4", "720P")).toEqual({ width: 720, height: 960 });
		expect(canvasSizeOf("4:3", "720P")).toEqual({ width: 960, height: 720 });
	});

	it("1:1 方形与 21:9 宽银幕", () => {
		expect(canvasSizeOf("1:1", "1080P")).toEqual({ width: 1080, height: 1080 });
		expect(canvasSizeOf("21:9", "1080P")).toEqual({ width: 2520, height: 1080 });
		expect(canvasSizeOf("21:9", "4K")).toEqual({ width: 5040, height: 2160 });
	});

	it("⚠ 所有档位组合宽高均为偶数（编码器 4:2:0 要求）", () => {
		for (const a of RTC_ASPECTS) {
			for (const r of RTC_RESOLUTIONS) {
				const { width, height } = canvasSizeOf(a.id, r.id);
				expect(width % 2, `${a.id}/${r.id} 宽`).toBe(0);
				expect(height % 2, `${a.id}/${r.id} 高`).toBe(0);
				expect(Math.min(width, height)).toBe(r.shortSide); // 短边恒等于分辨率基准
			}
		}
	});

	it("非法档位 id 回退默认档", () => {
		expect(canvasSizeOf("nope", "1080P")).toEqual({ width: 1920, height: 1080 });
		expect(canvasSizeOf("9:16", "8K")).toEqual({ width: 1080, height: 1920 });
		expect(canvasSizeOf("", "")).toEqual({ width: 1920, height: 1080 });
	});
});

describe("rtcCanvasSpec · makeEven", () => {
	it("向最近偶数取整", () => {
		expect(makeEven(1079)).toBe(1080);
		expect(makeEven(1080.4)).toBe(1080);
		expect(makeEven(1081)).toBe(1082); // 等距时向上（1081 距 1080/1082 相同）
		expect(makeEven(2520)).toBe(2520);
		expect(makeEven(2519.6)).toBe(2520);
	});

	it("下限 2；异常值兜底 2", () => {
		expect(makeEven(1)).toBe(2);
		expect(makeEven(0)).toBe(2);
		expect(makeEven(-100)).toBe(2);
		expect(makeEven(Number.NaN)).toBe(2);
		expect(makeEven(Number.POSITIVE_INFINITY)).toBe(2);
	});
});

describe("rtcCanvasSpec · resolveCanvasPreset 反解", () => {
	it("标准档位精确回显（全组合往返自洽）", () => {
		for (const a of RTC_ASPECTS) {
			for (const r of RTC_RESOLUTIONS) {
				const size = canvasSizeOf(a.id, r.id);
				expect(resolveCanvasPreset(size), `${a.id}/${r.id}`).toEqual({
					aspectId: a.id,
					resolutionId: r.id,
					exact: true,
				});
			}
		}
	});

	it("非标准尺寸就近匹配且 exact=false", () => {
		// 1000×1000 → 比例 1:1、短边最接近 1080P
		expect(resolveCanvasPreset({ width: 1000, height: 1000 })).toEqual({
			aspectId: "1:1",
			resolutionId: "1080P",
			exact: false,
		});
		// 上游常见 1280×768（5:3）→ 比例最接近 16:9、短边最接近 720P
		const r = resolveCanvasPreset({ width: 1280, height: 768 });
		expect(r.aspectId).toBe("16:9");
		expect(r.resolutionId).toBe("720P");
		expect(r.exact).toBe(false);
	});

	it("竖屏与横屏不会互相误判", () => {
		expect(resolveCanvasPreset({ width: 1088, height: 1920 }).aspectId).toBe("9:16");
		expect(resolveCanvasPreset({ width: 1920, height: 1088 }).aspectId).toBe("16:9");
		expect(resolveCanvasPreset({ width: 1024, height: 768 }).aspectId).toBe("4:3");
		expect(resolveCanvasPreset({ width: 768, height: 1024 }).aspectId).toBe("3:4");
	});

	it("超宽 / 超大 / 超小 极端值兜底到最近档", () => {
		expect(resolveCanvasPreset({ width: 5120, height: 2160 }).aspectId).toBe("21:9"); // 21.3:9
		expect(resolveCanvasPreset({ width: 7680, height: 4320 })).toMatchObject({ aspectId: "16:9", resolutionId: "4K" });
		expect(resolveCanvasPreset({ width: 64, height: 36 })).toMatchObject({ aspectId: "16:9", resolutionId: "720P" });
	});

	it("非法尺寸（0/负/NaN/缺字段）回退默认档", () => {
		const def = { aspectId: DEFAULT_ASPECT_ID, resolutionId: DEFAULT_RESOLUTION_ID, exact: false };
		expect(resolveCanvasPreset({ width: 0, height: 0 })).toEqual(def);
		expect(resolveCanvasPreset({ width: -1920, height: 1080 })).toEqual(def);
		expect(resolveCanvasPreset({ width: Number.NaN, height: 1080 })).toEqual(def);
		expect(resolveCanvasPreset({} as { width: number; height: number })).toEqual(def);
	});
});

describe("rtcCanvasSpec · aspectRatioOf / formatCanvasLabel / sameCanvas", () => {
	it("aspectRatioOf 返回宽高比；异常值回退默认 16:9", () => {
		expect(aspectRatioOf({ width: 1920, height: 1080 })).toBeCloseTo(16 / 9, 6);
		expect(aspectRatioOf({ width: 1080, height: 1920 })).toBeCloseTo(9 / 16, 6);
		expect(aspectRatioOf({ width: 0, height: 1080 })).toBeCloseTo(16 / 9, 6);
		expect(aspectRatioOf({ width: 100, height: Number.NaN })).toBeCloseTo(16 / 9, 6);
	});

	it("formatCanvasLabel：标准档带档位名、自定义尺寸标注（自定义）", () => {
		expect(formatCanvasLabel({ width: 1080, height: 1920 })).toBe("9:16 · 1080P（1080×1920）");
		expect(formatCanvasLabel({ width: 3840, height: 2160 })).toBe("16:9 · 4K（3840×2160）");
		expect(formatCanvasLabel({ width: 1000, height: 1000 })).toBe("1000×1000（自定义）");
		expect(formatCanvasLabel({ width: 0, height: 0 })).toBe("16:9 · 1080P（1920×1080）");
	});

	it("sameCanvas 按取整后逐像素比较", () => {
		expect(sameCanvas({ width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toBe(true);
		expect(sameCanvas({ width: 1920.4, height: 1080 }, { width: 1920, height: 1080 })).toBe(true);
		expect(sameCanvas({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toBe(false);
	});
});
