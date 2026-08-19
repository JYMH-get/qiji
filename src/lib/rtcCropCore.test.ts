import { describe, it, expect } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import {
	cropClipPathCss,
	cropOf,
	fitCropToRatio,
	isEmptyCrop,
	normalizeCrop,
	storeCrop,
	toJyCrop,
	withSegmentCrop,
} from "./rtcCropCore";

function seg(p: Partial<RtcSegment>): RtcSegment {
	return { id: p.id || "s1", kind: "media", targetStartUs: 0, targetDurationUs: 1_000_000, ...p };
}
function docOf(segments: RtcSegment[]): RtcDoc {
	const t: RtcTrack = { id: "t1", type: "video", segments };
	return { id: "d1", name: "测试", fps: 30, tracks: [t] };
}

describe("rtcCropCore · 收敛与落库", () => {
	it("normalizeCrop：夹 [0,1] + NaN 归 0 + 两边之和超限按比例同缩（至少留 10%）", () => {
		expect(normalizeCrop({ left: -0.2, top: NaN, right: 1.5, bottom: 0.1 })).toEqual({ left: 0, top: 0, right: 0.9, bottom: 0.1 });
		// left+right=1.2 > 0.9 → 同缩到 0.9（比例 0.5:0.7 保持）
		const n = normalizeCrop({ left: 0.5, top: 0, right: 0.7, bottom: 0 });
		expect(n.left + n.right).toBeCloseTo(0.9, 6);
		expect(n.left / n.right).toBeCloseTo(0.5 / 0.7, 4);
	});

	it("storeCrop：全 0 → undefined（不写字段）；非空 → 规整值", () => {
		expect(storeCrop({ left: 0, top: 0, right: 0, bottom: 0 })).toBeUndefined();
		expect(storeCrop({ left: 0.1, top: 0, right: 0, bottom: 0.2 })).toEqual({ left: 0.1, top: 0, right: 0, bottom: 0.2 });
	});

	it("cropOf：缺省/坏形状/全 0 → null；有效值 → 规整后返回", () => {
		expect(cropOf(seg({}))).toBeNull();
		expect(cropOf(seg({ crop: { left: 0, top: 0, right: 0, bottom: 0 } }))).toBeNull();
		expect(cropOf(seg({ crop: { left: 0.25, top: 0.1, right: 0, bottom: 0 } }))).toEqual({ left: 0.25, top: 0.1, right: 0, bottom: 0 });
	});

	it("withSegmentCrop：写入/清除/值未变原引用（no-op 判据）", () => {
		const d0 = docOf([seg({ id: "a" })]);
		const d1 = withSegmentCrop(d0, "a", { left: 0.2, top: 0, right: 0, bottom: 0 });
		expect(d1).not.toBe(d0);
		expect(d1.tracks[0].segments[0].crop).toEqual({ left: 0.2, top: 0, right: 0, bottom: 0 });
		// 同值再写 → 原引用
		expect(withSegmentCrop(d1, "a", { left: 0.2, top: 0, right: 0, bottom: 0 })).toBe(d1);
		// 清除 → 字段整个消失（不是 undefined 值残留）
		const d2 = withSegmentCrop(d1, "a", undefined);
		expect("crop" in d2.tracks[0].segments[0]).toBe(false);
		// 本就没有再清 → 原引用；片段不存在 → 原引用
		expect(withSegmentCrop(d2, "a", undefined)).toBe(d2);
		expect(withSegmentCrop(d2, "nope", { left: 0.1, top: 0, right: 0, bottom: 0 })).toBe(d2);
		// 全 0 写入等价清除
		expect(withSegmentCrop(d2, "a", { left: 0, top: 0, right: 0, bottom: 0 })).toBe(d2);
	});
});

describe("rtcCropCore · clip-path 换算", () => {
	it("不裁 → null（不写 clipPath 属性，零回归）", () => {
		expect(cropClipPathCss(null, { w: 1, h: 1 })).toBeNull();
		expect(cropClipPathCss({ left: 0, top: 0, right: 0, bottom: 0 }, { w: 1, h: 1 })).toBeNull();
	});

	it("整幅铺满（frac=1,1）→ inset 直接等于 crop 百分比", () => {
		expect(cropClipPathCss({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.05 }, { w: 1, h: 1 })).toBe(
			"inset(20% 30% 5% 10%)",
		);
	});

	it("contain 留黑折算：画面只占画幅一半高时，inset_top = 留黑 25% + crop.top×0.5", () => {
		// 素材 2:1 放进 1:1 画幅 → fw=1, fh=0.5，上下各留黑 25%
		const css = cropClipPathCss({ left: 0, top: 0.2, right: 0, bottom: 0 }, { w: 1, h: 0.5 });
		expect(css).toBe("inset(35% 0% 25% 0%)"); // 0.25 + 0.2×0.5 = 0.35；bottom 只有留黑 0.25
	});

	it("frac 未知（0/负）按整幅近似", () => {
		expect(cropClipPathCss({ left: 0.1, top: 0, right: 0, bottom: 0 }, { w: 0, h: -1 })).toBe("inset(0% 0% 0% 10%)");
	});
});

describe("rtcCropCore · 剪映 material.crop 映射", () => {
	it("8 角坐标：upper_left=(l,t)、lower_right=(1-r,1-b)（pyJianYingDraft CropSettings 同形）", () => {
		expect(toJyCrop({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.4 })).toEqual({
			upper_left_x: 0.1, upper_left_y: 0.2,
			upper_right_x: 0.7, upper_right_y: 0.2,
			lower_left_x: 0.1, lower_left_y: 0.6,
			lower_right_x: 0.7, lower_right_y: 0.6,
		});
	});

	it("不裁/缺省 → null（走去重单条 material 的常规路径）", () => {
		expect(toJyCrop(undefined)).toBeNull();
		expect(toJyCrop(null)).toBeNull();
		expect(toJyCrop({ left: 0, top: 0, right: 0, bottom: 0 })).toBeNull();
	});
});

describe("rtcCropCore · 比例预设", () => {
	it("16:9 素材上锁 1:1：以当前中心为锚、高向铺满、宽按比例收（区域像素比=1:1）", () => {
		const c = fitCropToRatio({ left: 0, top: 0, right: 0, bottom: 0 }, 16 / 9, 1);
		// 归一化：h=1（铺满），w = h/k = 1/(16/9) = 9/16
		expect(1 - c.top - c.bottom).toBeCloseTo(1, 3);
		expect(1 - c.left - c.right).toBeCloseTo(9 / 16, 3);
		// 像素比验证：w_n×16 / h_n×9 = 1（定点 4 位落库有 ~1e-4 量化误差，精度取 3）
		expect(((1 - c.left - c.right) * 16) / ((1 - c.top - c.bottom) * 9)).toBeCloseTo(1, 3);
		// 居中
		expect(c.left).toBeCloseTo(c.right, 3);
	});

	it("非法比值原样返回", () => {
		const c = { left: 0.1, top: 0, right: 0, bottom: 0 };
		expect(fitCropToRatio(c, 0, 1)).toBe(c);
		expect(fitCropToRatio(c, 16 / 9, NaN)).toBe(c);
	});

	it("isEmptyCrop 判据", () => {
		expect(isEmptyCrop({ left: 0, top: 0, right: 0, bottom: 0 })).toBe(true);
		expect(isEmptyCrop({ left: 0.001, top: 0, right: 0, bottom: 0 })).toBe(false);
	});
});
