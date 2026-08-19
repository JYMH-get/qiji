import { describe, expect, it } from "vitest";
import {
	CENTER_TABS,
	type CenterSelSnapshot,
	centerTabAutoSwitch,
	initialCenterTab,
} from "./rtcCenterTabCore";

/** 快照工厂：缺省全空；isShotPlaceholder 缺省按 segKind==="placeholder" 推（测试便利） */
const snap = (p: Partial<CenterSelSnapshot> = {}): CenterSelSnapshot => ({
	segId: null,
	segKind: null,
	isShotPlaceholder: p.segKind === "placeholder",
	assetKey: null,
	mediaKey: null,
	...p,
});

describe("rtcCenterTabCore", () => {
	it("CENTER_TABS：双页签固定顺序 AI 工作台 / 预览", () => {
		expect(CENTER_TABS.map((t) => t.id)).toEqual(["workbench", "preview"]);
		expect(CENTER_TABS.map((t) => t.label)).toEqual(["AI 工作台", "预览"]);
	});

	it("规则 4：初始页签——doc 无可播片段=AI 工作台，有=预览", () => {
		expect(initialCenterTab(false)).toBe("workbench");
		expect(initialCenterTab(true)).toBe("preview");
	});

	it("规则 1：新选中分镜占位符 → AI 工作台（null→A 与 A→B 都算新选中）", () => {
		expect(centerTabAutoSwitch(snap(), snap({ segId: "a", segKind: "placeholder" }))).toBe("workbench");
		expect(
			centerTabAutoSwitch(
				snap({ segId: "a", segKind: "placeholder" }),
				snap({ segId: "b", segKind: "placeholder" }),
			),
		).toBe("workbench");
	});

	it("规则 1 边界：同一选中不重复切；取消选中不切；无 shotRef 的占位/普通片段不切", () => {
		const a = snap({ segId: "a", segKind: "placeholder" });
		expect(centerTabAutoSwitch(a, a)).toBeNull();
		expect(centerTabAutoSwitch(a, snap())).toBeNull();
		// 自由结果占位（无 shotRef）：isShotPlaceholder=false，不进工作台
		expect(centerTabAutoSwitch(snap(), snap({ segId: "f", segKind: "placeholder", isShotPlaceholder: false }))).toBeNull();
		// 新选中 media 片段：既不是占位符也不是素材预览，不切
		expect(centerTabAutoSwitch(snap(), snap({ segId: "m", segKind: "media" }))).toBeNull();
	});

	it("规则 2：新选中左栏资产/媒体卡 → 预览（两通道各自比较）", () => {
		expect(centerTabAutoSwitch(snap(), snap({ assetKey: "characters:C01" }))).toBe("preview");
		expect(centerTabAutoSwitch(snap({ assetKey: "characters:C01" }), snap({ assetKey: "scenes:S01" }))).toBe("preview");
		expect(centerTabAutoSwitch(snap(), snap({ mediaKey: "vid-1" }))).toBe("preview");
		expect(centerTabAutoSwitch(snap({ mediaKey: "vid-1" }), snap({ mediaKey: "vid-2" }))).toBe("preview");
	});

	it("规则 2 边界：同一选中不重复切；取消不切；片段取消「露出」既有资产选中不切", () => {
		expect(centerTabAutoSwitch(snap({ assetKey: "characters:C01" }), snap({ assetKey: "characters:C01" }))).toBeNull();
		expect(centerTabAutoSwitch(snap({ assetKey: "characters:C01" }), snap())).toBeNull();
		expect(centerTabAutoSwitch(snap({ mediaKey: "vid-1" }), snap())).toBeNull();
		// seg:A + asset:X → 取消片段只剩 asset:X：不是新选中动作
		expect(
			centerTabAutoSwitch(
				snap({ segId: "a", segKind: "placeholder", assetKey: "characters:C01" }),
				snap({ assetKey: "characters:C01" }),
			),
		).toBeNull();
	});

	it("规则 3：同一片段 placeholder→media（成片替换占位符）→ 预览", () => {
		expect(
			centerTabAutoSwitch(
				snap({ segId: "a", segKind: "placeholder" }),
				snap({ segId: "a", segKind: "media" }),
			),
		).toBe("preview");
		// 换选另一个 media 片段（segId 变了）不是替换事件，不切
		expect(
			centerTabAutoSwitch(
				snap({ segId: "a", segKind: "placeholder" }),
				snap({ segId: "b", segKind: "media" }),
			),
		).toBeNull();
		// media→media（无 kind 变化）不切
		expect(
			centerTabAutoSwitch(snap({ segId: "a", segKind: "media" }), snap({ segId: "a", segKind: "media" })),
		).toBeNull();
	});

	it("优先级：同拍新选中占位符 + 新资产选中 → 以时间轴片段为准切工作台", () => {
		expect(
			centerTabAutoSwitch(snap(), snap({ segId: "a", segKind: "placeholder", assetKey: "characters:C01" })),
		).toBe("workbench");
	});

	it("完全无变化（全空）不切", () => {
		expect(centerTabAutoSwitch(snap(), snap())).toBeNull();
	});
});
