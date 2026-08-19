import { describe, it, expect } from "vitest";
import { DEFAULT_RTC_TRANSFORM, type RtcTransform } from "@/types/rtc";
import {
	FIT_FULL,
	SCALE_MAX,
	SCALE_MIN,
	alignOffsetRatio,
	clampOpacity,
	clampPosRatio,
	clampScale,
	containFit,
	isDefaultTransform,
	jyUniformScaleOn,
	normalizeRotation,
	normalizeTransform,
	parseNumeric,
	percentToScale,
	pxToRatio,
	ratioToPx,
	scaleToPercent,
	storeTransform,
	toJyClip,
} from "./rtcTransformCore";

const T = (p: Partial<RtcTransform> = {}): RtcTransform => ({ ...DEFAULT_RTC_TRANSFORM, ...p });

describe("像素 ↔ 比例（界面显示像素、内部存比例）", () => {
	it("比例 → 像素按画幅边长换算并取整", () => {
		expect(ratioToPx(0.25, 1920)).toBe(480);
		expect(ratioToPx(-0.5, 1080)).toBe(-540);
		expect(ratioToPx(0, 1920)).toBe(0);
		expect(ratioToPx(0.1234, 1920)).toBe(237); // 236.9 → 237
	});

	it("像素 → 比例，画幅边长非法（0/负/NaN）一律返回 0 而不是 Infinity/NaN", () => {
		expect(pxToRatio(480, 1920)).toBe(0.25);
		expect(pxToRatio(100, 0)).toBe(0);
		expect(pxToRatio(100, -10)).toBe(0);
		expect(pxToRatio(Number.NaN, 1920)).toBe(0);
	});

	it("往返换算稳定：整像素 → 比例 → 像素 回到原值", () => {
		for (const px of [-1920, -333, 0, 1, 777, 1920]) {
			expect(ratioToPx(pxToRatio(px, 1920), 1920)).toBe(px);
		}
	});

	it("同一比例在不同画幅下换出不同像素——切画幅档素材不失位的根据", () => {
		const ratio = pxToRatio(480, 1920); // 1080P 下右移 480px
		expect(ratioToPx(ratio, 3840)).toBe(960); // 4K 画幅下等比放大
	});
});

describe("百分比 ↔ 倍率 / 夹取 / 解析", () => {
	it("倍率与百分比互转（保留 1 位小数）", () => {
		expect(scaleToPercent(1)).toBe(100);
		expect(scaleToPercent(0.72)).toBe(72);
		expect(scaleToPercent(1 / 3)).toBe(33.3);
		expect(percentToScale(72)).toBe(0.72);
		expect(percentToScale(100)).toBe(1);
	});

	it("越界一律夹取，NaN 回退安全默认", () => {
		expect(clampScale(999)).toBe(SCALE_MAX);
		expect(clampScale(0)).toBe(SCALE_MIN);
		expect(clampScale(Number.NaN)).toBe(1);
		expect(clampOpacity(1.7)).toBe(1);
		expect(clampOpacity(-3)).toBe(0);
		expect(clampOpacity(Number.NaN)).toBe(1);
		expect(clampPosRatio(99)).toBe(5);
		expect(clampPosRatio(-99)).toBe(-5);
		expect(clampPosRatio(Number.NaN)).toBe(0);
	});

	it("旋转角归一到 [0,360)：负角回卷、超圈取模、360 归 0", () => {
		expect(normalizeRotation(0)).toBe(0);
		expect(normalizeRotation(-90)).toBe(270);
		expect(normalizeRotation(450)).toBe(90);
		expect(normalizeRotation(360)).toBe(0);
		expect(normalizeRotation(359.999)).toBe(0); // 四舍五入到 360 后回卷
		expect(normalizeRotation(12.345)).toBe(12.35);
		expect(normalizeRotation(Number.NaN)).toBe(0);
	});

	it("非法输入解析返回 null（调用方据此回退原值、不写库）", () => {
		expect(parseNumeric("")).toBeNull();
		expect(parseNumeric("   ")).toBeNull();
		expect(parseNumeric("abc")).toBeNull();
		expect(parseNumeric("12px+")).toBeNull();
		expect(parseNumeric("-12.5")).toBe(-12.5);
		expect(parseNumeric(" 72% ")).toBe(72);
		expect(parseNumeric("30°")).toBe(30);
		expect(parseNumeric("480px")).toBe(480);
	});
});

describe("contain 适配与对齐", () => {
	it("素材比画幅宽 → 宽向铺满、高向留黑；反之亦然；同比例=铺满", () => {
		const canvas = 16 / 9;
		expect(containFit(16 / 9, canvas)).toEqual({ w: 1, h: 1 });
		expect(containFit(32 / 9, canvas)).toEqual({ w: 1, h: 0.5 }); // 更宽 → 高只占一半
		expect(containFit(1, canvas)).toEqual({ w: 0.5625, h: 1 }); // 方形进横屏 → 宽占 9/16
	});

	it("素材比例未知/非法 → 兜底按铺满画幅（不瞎猜）", () => {
		expect(containFit(null, 16 / 9)).toEqual(FIT_FULL);
		expect(containFit(0, 16 / 9)).toEqual(FIT_FULL);
		expect(containFit(Number.NaN, 16 / 9)).toEqual(FIT_FULL);
		expect(containFit(1.5, 0)).toEqual(FIT_FULL);
	});

	it("铺满画幅时：左右上下贴边都是 0（本来就贴满），居中恒 0", () => {
		const t = T();
		for (const k of ["left", "right", "top", "bottom", "centerX", "centerY"] as const) {
			expect(alignOffsetRatio(k, FIT_FULL, t)).toBe(0);
		}
	});

	it("缩到 50% 后左贴边 = -0.25 画幅宽、右贴边 = +0.25（对称）", () => {
		const t = T({ scaleX: 0.5, scaleY: 0.5 });
		expect(alignOffsetRatio("left", FIT_FULL, t)).toBe(-0.25);
		expect(alignOffsetRatio("right", FIT_FULL, t)).toBe(0.25);
		expect(alignOffsetRatio("top", FIT_FULL, t)).toBe(-0.25);
		expect(alignOffsetRatio("bottom", FIT_FULL, t)).toBe(0.25);
		expect(alignOffsetRatio("centerX", FIT_FULL, t)).toBe(0);
	});

	it("contain 后留黑的方向按显示尺寸贴边（方形素材进 16:9 画幅：左贴边 = -(1-0.5625)/2）", () => {
		const fit = containFit(1, 16 / 9); // { w: 0.5625, h: 1 }
		expect(alignOffsetRatio("left", fit, T())).toBeCloseTo(-0.21875, 6);
		expect(alignOffsetRatio("right", fit, T())).toBeCloseTo(0.21875, 6);
		// 高向铺满 → 上下贴边无位移
		expect(alignOffsetRatio("top", fit, T())).toBe(0);
	});

	it("放大到 200%（比画幅大）→ 左贴边为正：素材左缘对画幅左缘、右侧溢出（同剪映）", () => {
		expect(alignOffsetRatio("left", FIT_FULL, T({ scaleX: 2, scaleY: 2 }))).toBe(0.5);
		expect(alignOffsetRatio("right", FIT_FULL, T({ scaleX: 2, scaleY: 2 }))).toBe(-0.5);
	});

	it("横向档只看 scaleX、纵向档只看 scaleY（两轴解锁后互不串）", () => {
		const t = T({ scaleX: 0.5, scaleY: 1 });
		expect(alignOffsetRatio("left", FIT_FULL, t)).toBe(-0.25);
		expect(alignOffsetRatio("top", FIT_FULL, t)).toBe(0);
	});
});

describe("规整与落库形态", () => {
	it("normalizeTransform 夹取全字段并丢掉 false 镜像键", () => {
		const n = normalizeTransform({ scaleX: 99, scaleY: -1, x: 88, y: -88, rotation: -30, opacity: 5, flipH: false, flipV: true });
		expect(n).toEqual({ scaleX: SCALE_MAX, scaleY: SCALE_MIN, x: 5, y: -5, rotation: 330, opacity: 1, flipV: true });
		expect("flipH" in n).toBe(false);
	});

	it("storeTransform：等于缺省 → undefined（项目文件里与从未调过同形）", () => {
		expect(storeTransform(T())).toBeUndefined();
		expect(storeTransform(T({ flipH: false }))).toBeUndefined();
		expect(storeTransform({ scaleX: 1, scaleY: 1, x: 0, y: 0, rotation: 360, opacity: 1 })).toBeUndefined();
		expect(storeTransform(T({ x: 0.1 }))).toEqual({ scaleX: 1, scaleY: 1, x: 0.1, y: 0, rotation: 0, opacity: 1 });
	});

	it("isDefaultTransform 认得镜像与旋转这类「看不出但存在」的改动", () => {
		expect(isDefaultTransform(T())).toBe(true);
		expect(isDefaultTransform(T({ flipH: true }))).toBe(false);
		expect(isDefaultTransform(T({ rotation: 0.01 }))).toBe(false);
		expect(isDefaultTransform(T({ opacity: 0.99 }))).toBe(false);
	});
});

describe("剪映 clip 映射（依据 pyJianYingDraft ClipSettings）", () => {
	it("缺省变换 → 「不变换」clip：与本轮之前硬编码的那份逐键一致（回归安全）", () => {
		expect(toJyClip(DEFAULT_RTC_TRANSFORM)).toEqual({
			alpha: 1,
			flip: { horizontal: false, vertical: false },
			rotation: 0,
			scale: { x: 1, y: 1 },
			transform: { x: 0, y: 0 },
		});
		expect(jyUniformScaleOn(DEFAULT_RTC_TRANSFORM)).toBe(true);
	});

	it("⚠ 位置：画幅比例 → 半画幅单位（×2），且 y 轴取负（剪映 transform_y 正向上）", () => {
		const c = toJyClip(T({ x: 0.25, y: 0.25 }));
		expect(c.transform).toEqual({ x: 0.5, y: -0.5 });
		// 向上移动（我们 y 为负）→ 剪映为正
		expect(toJyClip(T({ y: -0.4 })).transform.y).toBe(0.8);
		// 推到画幅边缘：半画幅单位下恰好 ±1
		expect(toJyClip(T({ x: 0.5 })).transform.x).toBe(1);
	});

	it("零位移不产生 -0（JSON/断言口径统一）", () => {
		const c = toJyClip(T({ y: 0 }));
		expect(Object.is(c.transform.y, -0)).toBe(false);
		expect(c.transform.y).toBe(0);
	});

	it("缩放/旋转/不透明度/镜像直传（旋转同为顺时针度数，归一到 [0,360)）", () => {
		const c = toJyClip(T({ scaleX: 0.72, scaleY: 1.5, rotation: -90, opacity: 0.4, flipH: true }));
		expect(c.scale).toEqual({ x: 0.72, y: 1.5 });
		expect(c.rotation).toBe(270);
		expect(c.alpha).toBe(0.4);
		expect(c.flip).toEqual({ horizontal: true, vertical: false });
	});

	it("越界值在映射时同样被夹住（不把脏数据写进草稿）", () => {
		const c = toJyClip({ scaleX: 999, scaleY: 0, x: 99, y: -99, rotation: 1000, opacity: 9 });
		expect(c.scale).toEqual({ x: SCALE_MAX, y: SCALE_MIN });
		expect(c.transform).toEqual({ x: 10, y: 10 }); // ±5 比例 → ±10 半画幅
		expect(c.alpha).toBe(1);
		expect(c.rotation).toBe(280);
	});

	it("uniform_scale.on = 两轴是否同值（解锁等比后剪映才分别采纳 x/y）", () => {
		expect(jyUniformScaleOn(T({ scaleX: 1.2, scaleY: 1.2 }))).toBe(true);
		expect(jyUniformScaleOn(T({ scaleX: 1.2, scaleY: 1.3 }))).toBe(false);
	});
});
