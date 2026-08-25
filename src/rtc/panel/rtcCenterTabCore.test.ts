import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { CENTER_TABS, initialCenterTab, mainTrackSegAt, resultLayerVisible } from "./rtcCenterTabCore";

describe("rtcCenterTabCore", () => {
	it("CENTER_TABS：双页签固定顺序 AI 工作台 / 预览", () => {
		expect(CENTER_TABS.map((t) => t.id)).toEqual(["workbench", "preview"]);
		expect(CENTER_TABS.map((t) => t.label)).toEqual(["AI 工作台", "预览"]);
	});

	it("初始页签：优先按播放头处片段（占位=工作台/有结果=预览），空白按 doc 有无可播片段兜底", () => {
		expect(initialCenterTab(false)).toBe("workbench");
		expect(initialCenterTab(true)).toBe("preview");
		expect(initialCenterTab(true, "placeholder")).toBe("workbench");
		expect(initialCenterTab(false, "media")).toBe("preview");
		expect(initialCenterTab(true, null)).toBe("preview");
	});

	/**
	 * ⚠ 第251轮需求⑨：**页签自动切换整体废止**——原「新选中占位→工作台 / 选素材→预览 /
	 * 占位变成片→预览 / 播放头跟随」四条规则与 centerTabAutoSwitch/CenterSelSnapshot 一并删除
	 * （用户实报「时间轴一动就回到预览，很影响正在整理提示词的状态」）。本模块不再导出任何自动切换判定；
	 * 「播放到无结果区间露出工作台」改由**层级**（resultLayerVisible）承载，页签态不动。
	 */
	it("模块不再导出任何自动切换判定（回归防线：谁想加回自动切页签，这条会先红）", async () => {
		const mod = await import("./rtcCenterTabCore");
		expect(Object.keys(mod).sort()).toEqual(["CENTER_TABS", "initialCenterTab", "mainTrackSegAt", "resultLayerVisible"]);
	});

	describe("resultLayerVisible：面层（结果预览）是否露出", () => {
		it("工作台页：面层恒不露出（任何播放头位置都盖不住工作台）", () => {
			for (const k of ["media", "compound", "placeholder", null, undefined]) {
				expect(resultLayerVisible("workbench", k)).toBe(false);
			}
		});

		it("预览页：播放头处有成片（media/compound）才露出", () => {
			expect(resultLayerVisible("preview", "media")).toBe(true);
			expect(resultLayerVisible("preview", "compound")).toBe(true);
		});

		it("预览页：播放头处是占位符 / 空白区间 → 让开，露出底下的工作台", () => {
			expect(resultLayerVisible("preview", "placeholder")).toBe(false);
			expect(resultLayerVisible("preview", null)).toBe(false);
			expect(resultLayerVisible("preview", undefined)).toBe(false);
		});
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
