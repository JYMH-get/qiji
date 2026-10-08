import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { useProjectStore } from "@/store/projectStore";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { isRtcShotListSelection, navigateRtcShot, rtcShotListTarget, useRtcShotNavigation } from "./rtcShotNavigation";
import { openRtcTimelineWorkbench } from "./rtcEpisodeWorkbenchView";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { useRtcCenterTabStore } from "../panel/rtcCenterTabStore";
import { chooseWorkbenchSegment, workbenchFocusMatches, workbenchSelectedId } from "../panel/rtcWorkbenchTargetCore";
import { mainTrackSegAt } from "../panel/rtcCenterTabCore";

const SEC = 1_000_000;
const scope = { projectId: "navigation-project", episodeId: "ep", subDocId: null, docId: "doc" };
const segment = (id: string, start: number): RtcSegment => ({ id, kind: "placeholder", targetStartUs: start * SEC,
	targetDurationUs: 10 * SEC, shotRef: { episodeId: "ep", shotId: id } });
const doc = (): RtcDoc => ({ id: "doc", name: "doc", fps: 30, tracks: [
	{ id: "main", type: "video", segments: [segment("seg2", 20), segment("seg4", 40)] },
] });
const active = () => activeRtcDoc(useRtcStore.getState())!;
const targetId = () => {
	if (isRtcShotListSelection()) return rtcShotListTarget()?.seg.id;
	const rtc = useRtcStore.getState(), current = activeRtcDoc(rtc);
	const selected = current?.tracks.flatMap(track => track.segments).find(seg => seg.id === workbenchSelectedId(rtc)) ?? null;
	return chooseWorkbenchSegment(selected, mainTrackSegAt(current, rtc.playheadUs)?.seg ?? null, workbenchFocusMatches(rtc.workbenchFocus, rtc))?.id;
};
const go = (id = "seg2", seek = false) => navigateRtcShot(scope, active(), `${id}/${id}`, seek);
const save = useProjectStore.getState().scheduleAutoSave;

beforeEach(() => {
	useRtcShotNavigation.setState({ reveal: null, listSelection: null });
	useProjectStore.setState({ projectInstanceId: scope.projectId, savePath: null, isProjectLoading: false, scheduleAutoSave: vi.fn(),
		rtcEpisodeId: "ep", rtcDocs: { ep: doc() }, episodes: [
			{ id: "ep", index: 1, title: "集", scriptText: "", shots: ["seg2", "seg4"].map((id, index) => ({ id, index, title: id, prompt: "", materials: [] })) },
			{ id: "other", index: 2, title: "另一集", scriptText: "", shots: [] },
		] });
	useRtcStore.getState().loadDoc(useProjectStore.getState().rtcDocs.ep);
	useRtcStore.getState().setPlayhead(21 * SEC);
	useRtcAssetSelStore.setState({ selected: null, mediaSel: null });
	useRtcCenterTabStore.setState({ tab: "preview", inited: true });
});
afterEach(() => { useProjectStore.setState({ scheduleAutoSave: save }); });

describe("分镜列表与时间轨选择互斥（真实 stores）", () => {
	it("单击仅选列表并清轨道多选，定位视口和AI目标，不移动播放头或文档", () => {
		useRtcStore.getState().setSelection(["seg2", "seg4"]);
		const before = useRtcStore.getState();
		expect(go("seg4")).toBe(true);
		expect(useRtcStore.getState().selection).toEqual([]);
		expect(useRtcStore.getState().playheadUs).toBe(before.playheadUs);
		expect(useRtcStore.getState().doc).toBe(before.doc);
		expect(useRtcStore.getState().past).toBe(before.past);
		expect(useRtcShotNavigation.getState().listSelection).toMatchObject({ rowKey: "seg4/seg4", segmentId: "seg4" });
		expect(useRtcShotNavigation.getState().reveal).toMatchObject({ segmentId: "seg4", positionUs: 40 * SEC });
		expect(isRtcShotListSelection()).toBe(true);
		expect(targetId()).toBe("seg4");
		expect(useRtcCenterTabStore.getState().tab).toBe("workbench");
	});
	it("列表2→时间轨4：只剩轨道4选中，工作台立即换4；反向点列表2也互斥", () => {
		go("seg2");
		expect(targetId()).toBe("seg2");
		useRtcStore.getState().setSelection(["seg4"], "seg4");
		expect(openRtcTimelineWorkbench("seg4")).toBe(true);
		expect(useRtcShotNavigation.getState().listSelection).toBeNull();
		expect(useRtcStore.getState().selection).toEqual(["seg4"]);
		expect(targetId()).toBe("seg4");
		go("seg2");
		expect(useRtcStore.getState().selection).toEqual([]);
		expect(targetId()).toBe("seg2");
	});
	it("同一个4重复点击与组内4点击都接管工作台，不破坏多选顺序", () => {
		const ids = ["seg2", "seg4"];
		useRtcStore.getState().setSelection(ids);
		useRtcCenterTabStore.getState().setTab("overview");
		expect(openRtcTimelineWorkbench("seg4")).toBe(true);
		expect(useRtcStore.getState().selection).toBe(ids);
		expect(targetId()).toBe("seg4");
		useRtcCenterTabStore.getState().setTab("preview");
		expect(openRtcTimelineWorkbench("seg4")).toBe(false);
		expect(useRtcCenterTabStore.getState().tab).toBe("preview");
		expect(openRtcTimelineWorkbench("seg4", "double")).toBe(true);
		expect(useRtcCenterTabStore.getState().tab).toBe("workbench");
		expect(targetId()).toBe("seg4");
	});
	it("列表选择后回预览，单击时间轨接管选中却不切页；双击才打开对应工作台", () => {
		go("seg2");
		useRtcCenterTabStore.getState().setTab("preview");
		const before = useRtcStore.getState();
		useRtcStore.getState().setSelection(["seg4"], "seg4");
		expect(openRtcTimelineWorkbench("seg4")).toBe(false);
		expect(useRtcShotNavigation.getState().listSelection).toBeNull();
		expect(useRtcStore.getState().selection).toEqual(["seg4"]);
		expect(useRtcCenterTabStore.getState().tab).toBe("preview");
		expect(openRtcTimelineWorkbench("seg4", "double")).toBe(true);
		expect(useRtcCenterTabStore.getState().tab).toBe("workbench");
		expect(targetId()).toBe("seg4");
		expect(useRtcStore.getState().doc).toBe(before.doc);
		expect(useRtcStore.getState().past).toBe(before.past);
		expect(useRtcStore.getState().playheadUs).toBe(before.playheadUs);
	});
	it("重复单击重发平滑定位；双击才seek并保留该行，之后播放移动恢复主轨", () => {
		go("seg4");
		const first = useRtcShotNavigation.getState().reveal;
		go("seg4");
		expect(useRtcShotNavigation.getState().reveal).not.toBe(first);
		expect(useRtcStore.getState().playheadUs).toBe(21 * SEC);
		go("seg4", true);
		expect(useRtcStore.getState().playheadUs).toBe(40 * SEC);
		expect(targetId()).toBe("seg4");
		expect(isRtcShotListSelection()).toBe(true);
		useRtcStore.getState().setPlayhead(21 * SEC);
		expect(useRtcShotNavigation.getState().listSelection).toBeNull();
		expect(targetId()).toBe("seg2");
	});
	it("同位置寻址和进度回填保留列表目标，清选区动作释放它", () => {
		go("seg4");
		useRtcStore.getState().setPlayhead(21 * SEC);
		useRtcStore.getState().patchSilent(current => ({ ...current, name: "生成进度更新" }));
		expect(targetId()).toBe("seg4");
		useRtcStore.getState().setSelection([]);
		expect(useRtcShotNavigation.getState().listSelection).toBeNull();
		expect(targetId()).toBe("seg2");
	});
	it("显式点普通素材不继续显示列表或播放头分镜的AI内容", () => {
		const current = active();
		useRtcStore.setState({ doc: { ...current, tracks: [{ ...current.tracks[0], segments: [...current.tracks[0].segments,
			{ id: "raw", kind: "media", media: "video", targetStartUs: 60 * SEC, targetDurationUs: 10 * SEC }] }] } });
		go("seg2");
		useRtcStore.getState().setSelection(["raw"], "raw");
		expect(openRtcTimelineWorkbench("raw")).toBe(true);
		expect(useRtcShotNavigation.getState().listSelection).toBeNull();
		expect(targetId()).toBeUndefined();
	});
	it.each(["project", "episode", "loading", "layer", "deleted-shot", "deleted-segment", "reload"])("%s变化清列表身份，返回旧状态也不复活", change => {
		useRtcStore.getState().setPlayhead(0);
		go("seg4");
		const before = useProjectStore.getState();
		if (change === "project") useProjectStore.setState({ projectInstanceId: "new" });
		if (change === "episode") useProjectStore.setState({ rtcEpisodeId: "other" });
		if (change === "loading") useProjectStore.setState({ isProjectLoading: true });
		if (change === "layer") useRtcStore.setState({ editingSubDocId: "child" });
		if (change === "deleted-shot") useProjectStore.setState({ episodes: before.episodes.map(ep => ({ ...ep, shots: [] })) });
		if (change === "deleted-segment") useRtcStore.getState().patchSilent(current => ({ ...current, tracks: [] }));
		if (change === "reload") useRtcStore.getState().loadDoc(active());
		expect(useRtcShotNavigation.getState().listSelection).toBeNull();
		useProjectStore.setState({ projectInstanceId: scope.projectId, rtcEpisodeId: "ep", isProjectLoading: false, episodes: before.episodes });
		useRtcStore.getState().loadDoc(doc());
		expect(useRtcShotNavigation.getState().listSelection).toBeNull();
	});
	it("过期的行快照与其他分集入口不更改选区/播放头", () => {
		const oldDoc = active();
		useRtcStore.setState({ doc: { ...oldDoc, name: "new" } });
		expect(navigateRtcShot(scope, oldDoc, "seg4/seg4", true)).toBe(false);
		expect(navigateRtcShot({ ...scope, episodeId: "other" }, active(), "seg4/seg4", true)).toBe(false);
		expect(useRtcStore.getState().selection).toEqual([]);
		expect(useRtcStore.getState().playheadUs).toBe(21 * SEC);
	});
	it("双击清素材预览，保持列表与轨道选择互斥", () => {
		useRtcAssetSelStore.setState({ mediaSel: { media: "image", uri: "test-image", key: "test", name: "预览图" } });
		go("seg4", true);
		expect(useRtcAssetSelStore.getState().mediaSel).toBeNull();
		expect(useRtcStore.getState().selection).toEqual([]);
	});
	it("复合内两行只高亮自身且定位宿主，不从主层编辑子镜；进子层后可独立选中", () => {
		const current = doc();
		current.subDocs = { child: { id: "child", name: "child", tracks: [
			{ id: "child-track", type: "video", segments: [segment("seg2", 0), segment("seg4", 10)] },
		] } };
		current.tracks[0].segments = [{ id: "host", kind: "compound", subDocId: "child", targetStartUs: 20 * SEC, targetDurationUs: 20 * SEC }];
		useRtcStore.getState().loadDoc(current);
		expect(navigateRtcShot(scope, active(), "host/seg2", false)).toBe(true);
		expect(navigateRtcShot(scope, active(), "host/seg4", true)).toBe(true);
		expect(useRtcShotNavigation.getState().listSelection?.rowKey).toBe("host/seg4");
		expect(useRtcStore.getState().selection).toEqual([]);
		expect(useRtcStore.getState().playheadUs).toBe(30 * SEC);
		expect(rtcShotListTarget()).toBeNull();
		expect(targetId()).toBeUndefined();
		useRtcStore.getState().enterCompound("child");
		expect(useRtcShotNavigation.getState().listSelection).toBeNull();
		const subScope = { ...scope, subDocId: "child", docId: active().id };
		expect(navigateRtcShot(subScope, active(), "seg4/seg4", false)).toBe(true);
		expect(targetId()).toBe("seg4");
		useRtcStore.getState().exitCompound();
		expect(useRtcShotNavigation.getState().listSelection).toBeNull();
	});
});
