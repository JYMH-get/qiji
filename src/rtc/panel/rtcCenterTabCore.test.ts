import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import {
	CENTER_TABS,
	type CenterSelSnapshot,
	centerTabAutoSwitch,
	initialCenterTab,
	mainTrackSegAt,
} from "./rtcCenterTabCore";

/** 快照工厂：缺省全空 */
const snap = (p: Partial<CenterSelSnapshot> = {}): CenterSelSnapshot => ({
	segId: null,
	segKind: null,
	assetKey: null,
	mediaKey: null,
	phSegId: null,
	phSegKind: null,
	...p,
});

describe("rtcCenterTabCore", () => {
	it("CENTER_TABS：双页签固定顺序 AI 工作台 / 预览", () => {
		expect(CENTER_TABS.map((t) => t.id)).toEqual(["workbench", "preview"]);
		expect(CENTER_TABS.map((t) => t.label)).toEqual(["AI 工作台", "预览"]);
	});

	it("规则 4：初始页签——优先按播放头处片段（占位=工作台/有结果=预览），空白按 doc 有无可播片段兜底", () => {
		expect(initialCenterTab(false)).toBe("workbench");
		expect(initialCenterTab(true)).toBe("preview");
		// 补充3：播放头处片段优先于 doc 兜底
		expect(initialCenterTab(true, "placeholder")).toBe("workbench");
		expect(initialCenterTab(false, "media")).toBe("preview");
		expect(initialCenterTab(true, null)).toBe("preview");
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

	it("规则 1 边界：同一选中不重复切；取消选中不切；普通片段不切", () => {
		const a = snap({ segId: "a", segKind: "placeholder" });
		expect(centerTabAutoSwitch(a, a)).toBeNull();
		expect(centerTabAutoSwitch(a, snap())).toBeNull();
		// 新选中 media 片段：既不是占位符也不是素材预览，不切
		expect(centerTabAutoSwitch(snap(), snap({ segId: "m", segKind: "media" }))).toBeNull();
	});

	it("规则 1 扩展（第240轮）：自由结果占位（无 shotRef 的 placeholder）新选中同样进工作台，成片替换回预览", () => {
		// 新选中自由占位 → 工作台（占位符一视同仁，不看 shotRef）
		expect(centerTabAutoSwitch(snap(), snap({ segId: "f", segKind: "placeholder" }))).toBe("workbench");
		// 分镜占位 → 自由占位（换选中）也是新选中占位符 → 工作台
		expect(
			centerTabAutoSwitch(
				snap({ segId: "a", segKind: "placeholder" }),
				snap({ segId: "f", segKind: "placeholder" }),
			),
		).toBe("workbench");
		// 自由占位成片替换（同 segId placeholder→media，规则 3 覆盖）→ 预览
		expect(
			centerTabAutoSwitch(
				snap({ segId: "f", segKind: "placeholder" }),
				snap({ segId: "f", segKind: "media" }),
			),
		).toBe("preview");
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

	it("规则 6（补充3 播放头跟随）：进入占位=工作台、进入成片=预览、所在占位被成片替换=预览、移到空白不动", () => {
		// 播放头进入占位符 → 工作台（这个时间点没有结果）
		expect(centerTabAutoSwitch(snap(), snap({ phSegId: "p1", phSegKind: "placeholder" }))).toBe("workbench");
		// 播放头进入成片/复合 → 预览（这个时间点有结果）
		expect(
			centerTabAutoSwitch(snap({ phSegId: "p1", phSegKind: "placeholder" }), snap({ phSegId: "m1", phSegKind: "media" })),
		).toBe("preview");
		expect(centerTabAutoSwitch(snap(), snap({ phSegId: "c1", phSegKind: "compound" }))).toBe("preview");
		// 播放头没动、所在占位被成片原位替换（同 id kind 变化）→ 预览
		expect(
			centerTabAutoSwitch(snap({ phSegId: "p1", phSegKind: "placeholder" }), snap({ phSegId: "p1", phSegKind: "media" })),
		).toBe("preview");
		// 移到空白（null）/停在同一片段 → 不动
		expect(centerTabAutoSwitch(snap({ phSegId: "p1", phSegKind: "placeholder" }), snap())).toBeNull();
		const stay = snap({ phSegId: "p1", phSegKind: "placeholder" });
		expect(centerTabAutoSwitch(stay, stay)).toBeNull();
	});

	it("规则 6 优先级：选择类信号与播放头信号同拍出现 → 以选择为准", () => {
		// 同拍：新选中占位符 + 播放头进入成片 → 工作台（规则 1 先判）
		expect(
			centerTabAutoSwitch(snap(), snap({ segId: "a", segKind: "placeholder", phSegId: "m1", phSegKind: "media" })),
		).toBe("workbench");
		// 同拍：新选中资产卡 + 播放头进入占位 → 预览（规则 2 先判）
		expect(
			centerTabAutoSwitch(snap(), snap({ assetKey: "characters:C01", phSegId: "p1", phSegKind: "placeholder" })),
		).toBe("preview");
	});

	it("mainTrackSegAt：主轨=第一条 video 轨；区间右开；空白/无主轨/无 doc = null", () => {
		const seg = (id: string, start: number, dur: number, kind: RtcSegment["kind"] = "placeholder"): RtcSegment => ({
			id, kind, targetStartUs: start, targetDurationUs: dur,
		});
		const doc: RtcDoc = {
			id: "d", name: "d", fps: 30,
			tracks: [
				{ id: "ta", type: "audio", segments: [seg("au", 0, 9_000_000, "media")] },
				{ id: "tv", type: "video", segments: [seg("p1", 0, 5_000_000), seg("m1", 5_000_000, 3_000_000, "media")] },
				{ id: "tv2", type: "video", segments: [seg("other", 0, 9_000_000, "media")] },
			],
		};
		expect(mainTrackSegAt(doc, 1_000_000)?.seg.id).toBe("p1");
		expect(mainTrackSegAt(doc, 5_000_000)?.seg.id).toBe("m1"); // 右开：交界归后一段
		expect(mainTrackSegAt(doc, 8_000_000)).toBeNull(); // m1 右缘（右开）→ 空白
		expect(mainTrackSegAt(doc, 7_999_999)?.segIndex).toBe(1);
		expect(mainTrackSegAt({ ...doc, tracks: [doc.tracks[0]] }, 0)).toBeNull(); // 无 video 轨
		expect(mainTrackSegAt(null, 0)).toBeNull();
	});
});
