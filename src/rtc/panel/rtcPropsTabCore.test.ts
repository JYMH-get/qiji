import { describe, expect, it } from "vitest";
import {
	PROPS_TABS,
	type PropsSelSnapshot,
	assetSelKey,
	shouldAutoSwitchToProps,
} from "./rtcPropsTabCore";

const snap = (segId: string | null, assetKey: string | null): PropsSelSnapshot => ({ segId, assetKey });

describe("rtcPropsTabCore", () => {
	it("PROPS_TABS：三页签固定顺序 属性/剧本/分镜，默认页=首个（属性）", () => {
		expect(PROPS_TABS.map((t) => t.id)).toEqual(["props", "script", "shots"]);
		expect(PROPS_TABS.map((t) => t.label)).toEqual(["属性", "剧本", "分镜"]);
		expect(PROPS_TABS[0].id).toBe("props");
	});

	it("assetSelKey：cat+id 拼稳定键；空选中=null", () => {
		expect(assetSelKey({ cat: "characters", id: "C01" })).toBe("characters:C01");
		expect(assetSelKey(null)).toBeNull();
		expect(assetSelKey(undefined)).toBeNull();
	});

	it("新选中片段 → 切（null→A 与 A→B 都算新的选中动作）", () => {
		expect(shouldAutoSwitchToProps(snap(null, null), snap("seg-a", null))).toBe(true);
		expect(shouldAutoSwitchToProps(snap("seg-a", null), snap("seg-b", null))).toBe(true);
	});

	it("同一选中不重复切", () => {
		expect(shouldAutoSwitchToProps(snap("seg-a", null), snap("seg-a", null))).toBe(false);
		expect(shouldAutoSwitchToProps(snap(null, "characters:C01"), snap(null, "characters:C01"))).toBe(false);
	});

	it("取消选中（→null）不切", () => {
		expect(shouldAutoSwitchToProps(snap("seg-a", null), snap(null, null))).toBe(false);
		expect(shouldAutoSwitchToProps(snap(null, "characters:C01"), snap(null, null))).toBe(false);
	});

	it("片段取消后「露出」既有资产选中：不是新选中动作，不切", () => {
		expect(
			shouldAutoSwitchToProps(snap("seg-a", "characters:C01"), snap(null, "characters:C01")),
		).toBe(false);
	});

	it("新选中资产 → 切（null→X 与 X→Y 都算）", () => {
		expect(shouldAutoSwitchToProps(snap(null, null), snap(null, "scenes:S01"))).toBe(true);
		expect(shouldAutoSwitchToProps(snap(null, "scenes:S01"), snap(null, "scenes:S02"))).toBe(true);
	});

	it("取消后再次选中同一目标 → 仍是新的选中动作，切", () => {
		expect(shouldAutoSwitchToProps(snap(null, null), snap("seg-a", null))).toBe(true);
		expect(shouldAutoSwitchToProps(snap(null, null), snap(null, "characters:C01"))).toBe(true);
	});

	it("双通道同时出新值 → 切", () => {
		expect(
			shouldAutoSwitchToProps(snap(null, null), snap("seg-a", "characters:C01")),
		).toBe(true);
	});

	it("完全无变化（双 null）不切", () => {
		expect(shouldAutoSwitchToProps(snap(null, null), snap(null, null))).toBe(false);
	});
});
