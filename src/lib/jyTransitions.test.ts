import { describe, it, expect } from "vitest";
import { JY_TRANSITIONS, clampTransitionUs, findJyTransition } from "./jyTransitions";

describe("jyTransitions · 资源表", () => {
	it("条目形状：effect_id 短数字串、resource_id 长数字串（勿对调——对调后剪映找不到资源）", () => {
		expect(JY_TRANSITIONS.length).toBeGreaterThanOrEqual(15);
		for (const t of JY_TRANSITIONS) {
			expect(t.name).toBeTruthy();
			expect(t.effectId).toMatch(/^\d{4,10}$/); // 短
			expect(t.resourceId).toMatch(/^\d{15,}$/); // 长
			expect(t.defaultDurationUs).toBeGreaterThanOrEqual(100_000);
			expect(typeof t.isOverlap).toBe("boolean");
		}
	});

	it("effect_id 唯一（下拉 value/查表键）", () => {
		const ids = JY_TRANSITIONS.map((t) => t.effectId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("锚点条目抽查：叠化（overlap）与闪黑（非 overlap）——pyJianYingDraft transition_meta 实值", () => {
		const dissolve = JY_TRANSITIONS.find((t) => t.name === "叠化")!;
		expect(dissolve).toMatchObject({ effectId: "322577", resourceId: "6724845717472416269", isOverlap: true, defaultDurationUs: 500_000 });
		const black = JY_TRANSITIONS.find((t) => t.name === "闪黑")!;
		expect(black).toMatchObject({ effectId: "321493", resourceId: "6724239388189921806", isOverlap: false });
	});

	it("findJyTransition / clampTransitionUs：查表与时长夹取（非法回该资源默认档）", () => {
		expect(findJyTransition("322577")?.name).toBe("叠化");
		expect(findJyTransition("no-such")).toBeUndefined();
		expect(clampTransitionUs(300_000)).toBe(300_000);
		expect(clampTransitionUs(50_000)).toBe(100_000); // 下限 0.1s
		expect(clampTransitionUs(9_000_000)).toBe(5_000_000); // 上限 5s
		expect(clampTransitionUs(NaN, "359359")).toBe(1_000_000); // 推近默认 1s
		expect(clampTransitionUs(undefined)).toBe(500_000); // 表外/无资源 → 0.5s
	});
});
