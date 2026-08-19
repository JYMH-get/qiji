import { describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_PREFS, RTC_ZOOM_STEPS, normalizePreviewPrefs, qualityScale } from "./rtcPreviewStore";

describe("normalizePreviewPrefs 读盘归一", () => {
	it("空/坏输入 → 全默认（且是副本，改不到常量）", () => {
		expect(normalizePreviewPrefs(null)).toEqual(DEFAULT_PREVIEW_PREFS);
		expect(normalizePreviewPrefs("x")).toEqual(DEFAULT_PREVIEW_PREFS);
		const p = normalizePreviewPrefs(null);
		p.loop = true;
		expect(DEFAULT_PREVIEW_PREFS.loop).toBe(false);
	});

	it("逐字段校验：非法档位/类型回默认，合法值原样带走", () => {
		const p = normalizePreviewPrefs({ quality: "标清", loop: "yes", maxDecodeLayers: 999, hideBoxWhilePlaying: false, uniformScale: false });
		expect(p.quality).toBe("original"); // 非枚举值 → 默认
		expect(p.loop).toBe(false); // 非布尔 → 默认
		expect(p.maxDecodeLayers).toBe(4); // 非档位 → 默认
		expect(p.hideBoxWhilePlaying).toBe(false); // 合法
		expect(p.uniformScale).toBe(false);
		expect(normalizePreviewPrefs({ quality: "standard", maxDecodeLayers: 8, loop: true }).quality).toBe("standard");
		expect(normalizePreviewPrefs({ maxDecodeLayers: 8 }).maxDecodeLayers).toBe(8);
	});

	it("未知键忽略、不炸读盘（旧版残留同 rtcLayoutCore 惯例）", () => {
		const p = normalizePreviewPrefs({ 已废弃的键: 1, zoom: 3, loop: true });
		expect(p.loop).toBe(true);
		expect(Object.keys(p).sort()).toEqual(["hideBoxWhilePlaying", "loop", "maxDecodeLayers", "quality", "uniformScale"]);
		expect("zoom" in p).toBe(false); // 缩放是会话态，绝不从盘里读
	});
});

describe("画质与缩放档位表", () => {
	it("画质档 → 渲染像素比例（原画=1，未知回退 1）", () => {
		expect(qualityScale("original")).toBe(1);
		expect(qualityScale("high")).toBe(0.75);
		expect(qualityScale("standard")).toBe(0.5);
		expect(qualityScale("不存在" as never)).toBe(1);
	});

	it("缩放档首项恒为「适应」（默认态），其余为倍率", () => {
		expect(RTC_ZOOM_STEPS[0].mode).toBe("fit");
		expect(RTC_ZOOM_STEPS.slice(1).every((z) => typeof z.mode === "number" && z.mode > 0)).toBe(true);
	});
});
