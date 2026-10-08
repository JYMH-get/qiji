import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi, UseBoundStore } from "zustand";
import type { VideoEpisode } from "@/services/projectFile";
import type { RtcDoc } from "@/types/rtc";

interface TestProject {
	projectInstanceId: string;
	rtcEpisodeId: string | null;
	isProjectLoading: boolean;
	episodes: VideoEpisode[];
	switchRtcEpisode: (id: string) => void;
}
interface TestRtc {
	doc: RtcDoc | null;
	ownerProjectId: string | null;
	ownerEpisodeKey: string | null;
	editingSubDocId: string | null;
	selection: string[];
	workbenchFocusRevision: number;
	playheadUs: number;
	setSelection: (ids: string[]) => void;
	setPlayhead: (us: number) => void;
	exitCompound: () => void;
}

// 保留真实 Zustand 的同步 subscribe/setState；只隔离项目持久化及播放器等无关依赖。
vi.mock("@/store/projectStore", async () => {
	const { create } = await import("zustand");
	return {
		resolveEpisodeKey: (id: string | null, episodes: VideoEpisode[]) =>
			id && episodes.some((ep) => ep.id === id) ? id : episodes[0]?.id ?? "",
		useProjectStore: create<TestProject>((set) => ({
			projectInstanceId: "p", rtcEpisodeId: "ep", isProjectLoading: false, episodes: [],
			switchRtcEpisode: (rtcEpisodeId) => set({ rtcEpisodeId }),
		})),
	};
});
vi.mock("@/store/rtcStore", async () => {
	const { create } = await import("zustand");
	return {
		activeRtcDoc: (state: TestRtc) => state.doc,
		useRtcStore: create<TestRtc>((set) => ({
			doc: null, ownerProjectId: "p", ownerEpisodeKey: "ep", editingSubDocId: null,
			selection: [], workbenchFocusRevision: 0, playheadUs: 7_000_000,
			setSelection: (selection) => set((state) => ({ selection, workbenchFocusRevision: state.workbenchFocusRevision + 1 })),
			setPlayhead: (playheadUs) => set({ playheadUs }),
			exitCompound: () => set({ editingSubDocId: null, selection: [], playheadUs: 0 }),
		})),
	};
});

import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { useRtcCenterTabStore } from "../panel/rtcCenterTabStore";
import { isRtcShotListSelection, useRtcShotNavigation } from "./rtcShotNavigation";
import { openRtcEpisodeShot, openRtcEpisodeWorkbench, openRtcTimelineWorkbench, useRtcEpisodeWorkbenchView } from "./rtcEpisodeWorkbenchView";

const project = useProjectStore as unknown as UseBoundStore<StoreApi<TestProject>>;
const rtc = useRtcStore as unknown as UseBoundStore<StoreApi<TestRtc>>;
const target = () => useRtcEpisodeWorkbenchView.getState().target;
const episodes = (): VideoEpisode[] => [
	{ id: "ep", index: 1, title: "第一集", scriptText: "原文", shots: [{ id: "shot", index: 1, title: "分镜1", prompt: "", materials: [] }] },
	{ id: "other", index: 2, title: "第二集", scriptText: "另一集", shots: [] },
];
const document = (): RtcDoc => ({
	id: "doc", name: "第一集", fps: 30,
	tracks: [{ id: "main", type: "video", segments: [{
		id: "seg", kind: "placeholder", targetStartUs: 20_000_000, targetDurationUs: 10_000_000,
		shotRef: { episodeId: "ep", shotId: "shot" },
	}] }],
});

beforeEach(() => {
	useRtcEpisodeWorkbenchView.setState({ target: null });
	project.setState({ projectInstanceId: "p", rtcEpisodeId: "ep", isProjectLoading: false, episodes: episodes() });
	rtc.setState({ doc: document(), ownerProjectId: "p", ownerEpisodeKey: "ep", editingSubDocId: null,
		selection: [], workbenchFocusRevision: 0, playheadUs: 7_000_000 });
	useRtcCenterTabStore.setState({ tab: "preview", inited: true, scriptEditorOpen: false, scriptEditorHidden: false });
	useRtcAssetSelStore.setState({ selected: null, mediaSel: null });
	useRtcShotNavigation.setState({ reveal: null, listSelection: null });
});

describe("整集工作台会话视图", () => {
	it.each(["asset", "media"])("点击分集切到工作台并清除 %s 预览，保留原文草稿遮层", (kind) => {
		if (kind === "asset") useRtcAssetSelStore.getState().select({ cat: "characters", id: "character" });
		else useRtcAssetSelStore.getState().toggleMedia({ key: "media", uri: "image", media: "image", name: "预览" });
		useRtcCenterTabStore.getState().setScriptEditorOpen(true);
		rtc.getState().setSelection(["seg"]);
		const originalDoc = rtc.getState().doc;

		openRtcEpisodeWorkbench("ep");

		expect(target()).toEqual({ projectId: "p", episodeId: "ep" });
		expect(useRtcCenterTabStore.getState()).toMatchObject({ tab: "overview", scriptEditorOpen: true, scriptEditorHidden: true });
		expect(useRtcAssetSelStore.getState()).toMatchObject({ selected: null, mediaSel: null });
		expect(rtc.getState()).toMatchObject({ selection: [], playheadUs: 7_000_000 });
		expect(rtc.getState().doc).toBe(originalDoc);
	});

	it("点击另一集会切换分集，打开全新整集目标", () => {
		openRtcEpisodeWorkbench("ep");
		openRtcEpisodeWorkbench("other");
		expect(project.getState().rtcEpisodeId).toBe("other");
		expect(target()).toEqual({ projectId: "p", episodeId: "other" });
	});

	it("从复合层打开整集返回主层，保留原文编辑器", () => {
		rtc.setState({ editingSubDocId: "sub", selection: ["child"] });
		useRtcCenterTabStore.getState().setScriptEditorOpen(true);
		openRtcEpisodeWorkbench("ep");
		expect(rtc.getState()).toMatchObject({ editingSubDocId: null, selection: [], playheadUs: 0 });
		expect(target()?.episodeId).toBe("ep");
		expect(useRtcCenterTabStore.getState().scriptEditorOpen).toBe(true);
	});

	it("Tab 来回保留同一个整集目标", () => {
		openRtcEpisodeWorkbench("ep");
		const opened = target();
		useRtcCenterTabStore.getState().setTab("preview");
		expect(target()).toBe(opened);
		useRtcCenterTabStore.getState().setTab("workbench");
		expect(target()).toBe(opened);
	});

	it("流式分镜和文档更新、播放头前进、清空选区都不退出整集", () => {
		openRtcEpisodeWorkbench("ep");
		const opened = target();
		project.setState((state) => ({ episodes: state.episodes.map((ep) => ep.id !== "ep" ? ep : {
			...ep, shots: [...ep.shots, { id: "streamed", index: 2, title: "分镜2", prompt: "新卡", materials: [] }],
		}) }));
		rtc.setState({ doc: { ...rtc.getState().doc!, name: "流式更新" } });
		rtc.getState().setPlayhead(8_000_000);
		rtc.getState().setSelection([]);
		// 模拟撤销或文档收编恢复选区；没有新的明确选择事件，不应退出。
		rtc.setState({ selection: ["seg"] });
		expect(target()).toBe(opened);
	});

	it.each([false, true])("新的非空选择退出整集（重复点击已选素材=%s）", (alreadySelected) => {
		openRtcEpisodeWorkbench("ep");
		if (alreadySelected) rtc.setState({ selection: ["seg"] });
		expect(target()).not.toBeNull();
		rtc.getState().setSelection(["seg"]);
		expect(target()).toBeNull();
	});

	it.each(["project", "episode", "loading", "deleted"])("%s 变化立即失效，恢复旧身份也不会复活", (change) => {
		openRtcEpisodeWorkbench("ep");
		if (change === "project") project.setState({ projectInstanceId: "new-project" });
		if (change === "episode") project.getState().switchRtcEpisode("other");
		if (change === "loading") project.setState({ isProjectLoading: true });
		if (change === "deleted") project.setState({ episodes: project.getState().episodes.filter((ep) => ep.id !== "ep") });
		expect(target()).toBeNull();
		project.setState({ projectInstanceId: "p", rtcEpisodeId: "ep", isProjectLoading: false, episodes: episodes() });
		expect(target()).toBeNull();
	});

	it("原始分集选择为空但仍解析到当前集时，不误关闭整集", () => {
		openRtcEpisodeWorkbench("ep");
		project.setState({ rtcEpisodeId: null });
		expect(target()?.episodeId).toBe("ep");
		project.setState((state) => ({ episodes: [...state.episodes].reverse() }));
		expect(target()).toBeNull();
	});

	it.each(["loading", "missing"])("%s 时不打开整集、不改页签或预览", (reason) => {
		useRtcAssetSelStore.getState().select({ cat: "characters", id: "character" });
		if (reason === "loading") project.setState({ isProjectLoading: true });
		openRtcEpisodeWorkbench(reason === "missing" ? "deleted" : "ep");
		expect(target()).toBeNull();
		expect(useRtcCenterTabStore.getState().tab).toBe("preview");
		expect(useRtcAssetSelStore.getState().selected?.id).toBe("character");
	});
});

describe("整集表格查看单镜", () => {
	it.each(["overview", "workbench"] as const)("从 %s 重复点击已选片段仍进入单镜，保留播放头", (tab) => {
		rtc.getState().setSelection(["seg"]);
		useRtcCenterTabStore.getState().setScriptEditorOpen(true);
		useRtcCenterTabStore.getState().setTab(tab);
		useRtcAssetSelStore.getState().toggleMedia({ key: "media", uri: "image", media: "image", name: "预览" });
		const originalDoc = rtc.getState().doc;
		expect(openRtcTimelineWorkbench("seg")).toBe(true);
		expect(useRtcCenterTabStore.getState()).toMatchObject({ tab: "workbench", scriptEditorOpen: true, scriptEditorHidden: true });
		expect(useRtcAssetSelStore.getState().mediaSel).toBeNull();
		expect(rtc.getState().playheadUs).toBe(7_000_000);
		expect(rtc.getState().doc).toBe(originalDoc);
	});
	it("预览页单击保持预览，双击才进入单镜，不移动播放头或修改文档", () => {
		rtc.getState().setSelection(["seg"]);
		const before = rtc.getState();
		expect(openRtcTimelineWorkbench("seg")).toBe(false);
		expect(useRtcCenterTabStore.getState().tab).toBe("preview");
		expect(rtc.getState()).toBe(before);
		expect(openRtcTimelineWorkbench("seg", "double")).toBe(true);
		expect(useRtcCenterTabStore.getState().tab).toBe("workbench");
		expect(rtc.getState()).toMatchObject({ selection: ["seg"], playheadUs: before.playheadUs });
		expect(rtc.getState().doc).toBe(before.doc);
	});
	it.each(["loading", "owner", "missing", "unselected"])("拒绝 %s 的片段点击，不切页", reason => {
		rtc.getState().setSelection(["seg"]);
		if (reason === "loading") project.setState({ isProjectLoading: true });
		if (reason === "owner") rtc.setState({ ownerProjectId: "old" });
		if (reason === "unselected") rtc.getState().setSelection([]);
		expect(openRtcTimelineWorkbench(reason === "missing" ? "missing" : "seg", "double")).toBe(false);
		expect(useRtcCenterTabStore.getState().tab).toBe("preview");
	});
	it("切页隐藏剧本面，再次打开恢复显示状态", () => {
		useRtcCenterTabStore.getState().setScriptEditorOpen(true);
		useRtcCenterTabStore.getState().setTab("preview");
		expect(useRtcCenterTabStore.getState()).toMatchObject({ scriptEditorOpen: true, scriptEditorHidden: true });
		useRtcCenterTabStore.getState().setScriptEditorOpen(true);
		expect(useRtcCenterTabStore.getState()).toMatchObject({ scriptEditorOpen: true, scriptEditorHidden: false });
	});
	it("复用真实列表导航，定位已有片段并回工作台，播放头和文档不变", () => {
		openRtcEpisodeWorkbench("ep");
		useRtcCenterTabStore.getState().setTab("preview");
		useRtcAssetSelStore.getState().toggleMedia({ key: "media", uri: "image", media: "image", name: "预览" });
		const originalDoc = rtc.getState().doc;
		expect(openRtcEpisodeShot("ep", "shot")).toBe(true);
		expect(target()).toBeNull();
		expect(useRtcCenterTabStore.getState().tab).toBe("workbench");
		expect(rtc.getState()).toMatchObject({ selection: [], playheadUs: 7_000_000 });
		expect(rtc.getState().doc).toBe(originalDoc);
		expect(useRtcAssetSelStore.getState().mediaSel).toBeNull();
		expect(useRtcShotNavigation.getState().reveal).toMatchObject({ segmentId: "seg", positionUs: 20_000_000 });
		expect(isRtcShotListSelection()).toBe(true);
	});

	it("查看已删除的时间轴片段不重建，保留整集视图和播放头", () => {
		openRtcEpisodeWorkbench("ep");
		const deletedDoc = document();
		deletedDoc.tracks[0].segments = [];
		rtc.setState({ doc: deletedDoc });
		expect(openRtcEpisodeShot("ep", "shot")).toBe(false);
		expect(rtc.getState().doc).toBe(deletedDoc);
		expect(rtc.getState()).toMatchObject({ selection: [], playheadUs: 7_000_000 });
		expect(target()?.episodeId).toBe("ep");
		expect(useRtcShotNavigation.getState().reveal).toBeNull();
	});

	it.each(["loading", "inactive-episode", "rtc-owner"])("%s 状态拒绝旧单镜定位", (change) => {
		if (change === "loading") project.setState({ isProjectLoading: true });
		if (change === "inactive-episode") project.setState({ rtcEpisodeId: "other" });
		if (change === "rtc-owner") rtc.setState({ ownerProjectId: "old-project" });
		const originalDoc = rtc.getState().doc;
		expect(openRtcEpisodeShot("ep", "shot")).toBe(false);
		expect(rtc.getState().doc).toBe(originalDoc);
		expect(rtc.getState()).toMatchObject({ selection: [], playheadUs: 7_000_000 });
		expect(useRtcCenterTabStore.getState().tab).toBe("preview");
	});

	it("复合内分镜定位到宿主，保持主层与当前播放头", () => {
		const doc = document();
		const child = doc.tracks[0].segments[0];
		doc.subDocs = { sub: { id: "sub", name: "复合内容", tracks: [{ id: "child-track", type: "video", segments: [{ ...child, targetStartUs: 0 }] }] } };
		doc.tracks[0].segments = [{ id: "host", kind: "compound", subDocId: "sub", targetStartUs: 30_000_000, targetDurationUs: 10_000_000 }];
		rtc.setState({ doc });
		openRtcEpisodeWorkbench("ep");
		expect(openRtcEpisodeShot("ep", "shot")).toBe(true);
		expect(rtc.getState()).toMatchObject({ selection: [], editingSubDocId: null, playheadUs: 7_000_000 });
		expect(useRtcShotNavigation.getState().reveal).toMatchObject({ segmentId: "host", positionUs: 30_000_000 });
		expect(rtc.getState().doc).toBe(doc);
	});
});
