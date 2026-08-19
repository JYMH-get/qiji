import { describe, expect, it } from "vitest";
import {
	ASSET_W,
	DEFAULT_SLOT_ORDER,
	PROPS_W,
	clamp,
	defaultLayout,
	isValidSlotOrder,
	normalizeLayout,
	swapSlots,
	timelineBounds,
} from "./rtcLayoutCore";

describe("rtcLayoutCore", () => {
	it("clamp 夹取上下界", () => {
		expect(clamp(100, 220, 520)).toBe(220);
		expect(clamp(9999, 220, 520)).toBe(520);
		expect(clamp(300, 220, 520)).toBe(300);
	});

	it("timelineBounds 按视口高换算 20vh–60vh；异常视口回退 800", () => {
		expect(timelineBounds(1000)).toEqual({ min: 200, max: 600 });
		expect(timelineBounds(0)).toEqual({ min: 160, max: 480 });
		expect(timelineBounds(Number.NaN)).toEqual({ min: 160, max: 480 });
	});

	it("defaultLayout：默认序 + 默认尺寸 + 35vh 时间轴", () => {
		const l = defaultLayout(1000);
		expect(l.slotOrder).toEqual(["asset", "stage", "props"]);
		expect(l.assetWidth).toBe(ASSET_W.def);
		expect(l.propsWidth).toBe(PROPS_W.def);
		expect(l.timelineHeight).toBe(350);
	});

	it("swapSlots 置换两个槽位", () => {
		expect(swapSlots(["asset", "stage", "props"], "asset", "props")).toEqual(["props", "stage", "asset"]);
		expect(swapSlots(["asset", "stage", "props"], "stage", "asset")).toEqual(["stage", "asset", "props"]);
	});

	it("swapSlots no-op（同 id / 未知 id）返回原引用", () => {
		const order: readonly ("asset" | "stage" | "props")[] = ["asset", "stage", "props"];
		expect(swapSlots(order, "asset", "asset")).toBe(order);
		// @ts-expect-error 故意喂未知 id 验证防御
		expect(swapSlots(order, "asset", "bogus")).toBe(order);
	});

	it("isValidSlotOrder：只认三槽位的排列", () => {
		expect(isValidSlotOrder(["props", "asset", "stage"])).toBe(true);
		expect(isValidSlotOrder(["asset", "stage"])).toBe(false);
		expect(isValidSlotOrder(["asset", "asset", "stage"])).toBe(false);
		expect(isValidSlotOrder("asset,stage,props")).toBe(false);
		expect(isValidSlotOrder(null)).toBe(false);
	});

	it("normalizeLayout：非对象整体回默认", () => {
		const def = defaultLayout(1000);
		expect(normalizeLayout(null, 1000)).toEqual(def);
		expect(normalizeLayout("junk", 1000)).toEqual(def);
		expect(normalizeLayout([1, 2, 3], 1000)).toEqual(def);
	});

	it("normalizeLayout：合法值原样保留（取整）", () => {
		const l = normalizeLayout(
			{ slotOrder: ["stage", "asset", "props"], assetWidth: 260.6, propsWidth: 400, timelineHeight: 300 },
			1000,
		);
		expect(l.slotOrder).toEqual(["stage", "asset", "props"]);
		expect(l.assetWidth).toBe(261);
		expect(l.propsWidth).toBe(400);
		expect(l.timelineHeight).toBe(300);
	});

	it("normalizeLayout：越界值钳回范围（propsWidth 上限=640，三页签放宽）", () => {
		const l = normalizeLayout(
			{ assetWidth: 10, propsWidth: 9000, timelineHeight: 9000 },
			1000,
		);
		expect(l.assetWidth).toBe(ASSET_W.min);
		expect(l.propsWidth).toBe(PROPS_W.max);
		expect(PROPS_W.max).toBe(640);
		expect(l.timelineHeight).toBe(600); // 60vh @1000
	});

	it("normalizeLayout：坏字段逐个回默认，不拖累好字段", () => {
		const l = normalizeLayout(
			{ slotOrder: ["asset", "asset", "asset"], assetWidth: "wide", propsWidth: 480, timelineHeight: Number.NaN },
			1000,
		);
		expect(l.slotOrder).toEqual([...DEFAULT_SLOT_ORDER]);
		expect(l.assetWidth).toBe(ASSET_W.def);
		expect(l.propsWidth).toBe(480);
		expect(l.timelineHeight).toBe(350);
	});

	it("normalizeLayout：旧版 guideWidth/guideCollapsed（AI 生成子栏）键被忽略、读盘不炸", () => {
		const l = normalizeLayout(
			{ slotOrder: ["props", "stage", "asset"], assetWidth: 300, propsWidth: 400, timelineHeight: 300, guideWidth: 320, guideCollapsed: true },
			1000,
		);
		expect(l.slotOrder).toEqual(["props", "stage", "asset"]);
		expect(l.propsWidth).toBe(400);
		expect(Object.keys(l)).not.toContain("guideWidth");
		expect(Object.keys(l)).not.toContain("guideCollapsed");
	});

	it("normalizeLayout：slotOrder 返回新数组（不共享外部引用）", () => {
		const src: ("asset" | "stage" | "props")[] = ["props", "stage", "asset"];
		const l = normalizeLayout({ slotOrder: src }, 1000);
		expect(l.slotOrder).toEqual(src);
		expect(l.slotOrder).not.toBe(src);
	});
});
