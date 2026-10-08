import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShotMaterial, StoryboardShot } from "@/services/projectFile";
import { useProjectStore } from "@/store/projectStore";
import { useLightboxStore } from "@/store/lightboxStore";
import { usePromptModalStore, type PromptModalApi } from "@/store/promptModalStore";
import { buildLegend } from "./shotMaterials";
import { createShotMaterialLightboxSource, openShotMaterialLightbox } from "./shotMaterialLightbox";

const material = (id: string, media: ShotMaterial["media"] = "image", uri = `asset://${id}`, extra: Partial<ShotMaterial> = {}): ShotMaterial => ({
	id, assetId: `asset-${id}`, kind: "local", name: id, media, uri, ...extra,
});
const liveShot = () => useProjectStore.getState().episodes[0].shots[0];
const originalSave = useProjectStore.getState().scheduleAutoSave;
function seed(materials = [material("a"), material("b")], patch: Partial<StoryboardShot> = {}) {
	useProjectStore.setState({
		projectInstanceId: "owner-a", isProjectLoading: false, savePath: null,
		scheduleAutoSave: vi.fn(), mediaSettings: { imgVideoSameSource: true },
		episodes: [{ id: "ep", index: 1, title: "集", scriptText: "", shots: [{
			id: "shot", index: 1, title: "镜", scriptSegment: "", prompt: "", materials, ...patch,
		}] }],
	});
}

beforeEach(() => { useLightboxStore.getState().close(); usePromptModalStore.getState().close(); seed(); });
afterEach(() => { useLightboxStore.getState().close(); usePromptModalStore.getState().close(); useProjectStore.setState({ scheduleAutoSave: originalSave }); });

describe("分镜素材灯箱实时来源", () => {
	it("以稳定 ID 区分同 URI，标签按完整素材编号且不浏览上传占位", () => {
		seed([material("upload", "image", ""), material("a", "image", "same"), material("v", "video"), material("b", "image", "same"), material("sound", "audio")]);
		const items = createShotMaterialLightboxSource("ep", "shot").getItems();
		expect(items?.map(item => [item.id, item.label, item.media])).toEqual([
			["a", "图片2", "image"], ["v", "视频1", "video"], ["b", "图片3", "image"], ["sound", "音频1", "audio"],
		]);
		expect(items?.[0].thumbnailUri).toBe("same");
	});

	it("新增、删除和 URI 更新可实时读取，并支持取消订阅", () => {
		const source = createShotMaterialLightboxSource("ep", "shot");
		const listener = vi.fn();
		const unsubscribe = source.subscribe!(listener);
		useProjectStore.getState().updateShot("ep", "shot", { materials: [material("b", "image", "updated"), material("c")] });
		expect(listener).toHaveBeenCalledOnce();
		expect(source.getItems()?.map(item => [item.id, item.uri])).toEqual([["b", "updated"], ["c", "asset://c"]]);
		unsubscribe();
		useProjectStore.getState().updateShot("ep", "shot", { title: "changed" });
		expect(listener).toHaveBeenCalledOnce();
	});

	it("拖动使用打开后的最新素材，三份正文和图例同步 remap，保留素材角色", () => {
		const a = material("a", "image", undefined, { usage: "identity", rtcFrameRole: "first" });
		const b = material("b");
		seed([a, b]);
		const source = createShotMaterialLightboxSource("ep", "shot");
		const materials = [a, b, material("c")];
		const prompt = `${buildLegend(materials, false)}\n\n主体 @Image3 面向 @Image1`;
		useProjectStore.getState().updateShot("ep", "shot", {
			materials, videoPrompt: prompt, storyboardPrompt: prompt, unifiedPrompt: prompt,
		});
		source.reorder!("c", "a");
		const shot = liveShot();
		expect(shot.materials.map(item => item.id)).toEqual(["c", "a", "b"]);
		for (const text of [shot.videoPrompt, shot.storyboardPrompt, shot.unifiedPrompt]) {
			expect(text).toContain("主体 @Image1 面向 @Image2");
			expect(text).toContain("@Image1 是 c；@Image2 是 a；@Image3 是 b；");
		}
		expect(shot.materials[1]).toMatchObject({ id: "a", usage: "identity", rtcFrameRole: "first" });
		expect(shot.overrides?.officialAssetIndexes).toEqual([1]);
		expect(useProjectStore.getState().scheduleAutoSave).toHaveBeenCalled();
	});

	it("RTC 编辑能力动态变化后阻止重排，恢复能力后可以排序", () => {
		let editable = true;
		const source = createShotMaterialLightboxSource("ep", "shot", { canReorder: () => editable });
		editable = false;
		expect(source.canReorder!()).toBe(false);
		source.reorder!("b", "a");
		expect(liveShot().materials.map(item => item.id)).toEqual(["a", "b"]);
		editable = true;
		source.reorder!("b", "a");
		expect(liveShot().materials.map(item => item.id)).toEqual(["b", "a"]);
	});

	it("同 ID 的另一项目不能被旧来源查看或排序", () => {
		const source = createShotMaterialLightboxSource("ep", "shot");
		useProjectStore.setState({ projectInstanceId: "owner-b" });
		expect(source.getItems()).toBeNull();
		expect(source.canReorder!()).toBe(false);
		source.reorder!("b", "a");
		expect(liveShot().materials.map(item => item.id)).toEqual(["a", "b"]);
	});

	it.each(["loading", "shot-deleted", "episode-deleted"])("来源失效 %s 时关闭已打开灯箱且不可写", reason => {
		openShotMaterialLightbox("ep", "shot", "b");
		const source = useLightboxStore.getState().source!;
		if (reason === "loading") useProjectStore.setState({ isProjectLoading: true });
		else if (reason === "shot-deleted") useProjectStore.setState({ episodes: [{ ...useProjectStore.getState().episodes[0], shots: [] }] });
		else useProjectStore.setState({ episodes: [] });
		expect(source.getItems()).toBeNull();
		source.reorder!("b", "a");
		expect(useLightboxStore.getState().item).toBeNull();
		expect(useProjectStore.getState().scheduleAutoSave).not.toHaveBeenCalled();
	});

	it("打开精确目标，排序后仍显示同一素材并更新编号，删除它后选邻项", () => {
		openShotMaterialLightbox("ep", "shot", "b");
		expect(useLightboxStore.getState().item).toMatchObject({ id: "b", label: "图片2" });
		useLightboxStore.getState().reorder("b", "a");
		expect(useLightboxStore.getState().item).toMatchObject({ id: "b", label: "图片1" });
		expect(useLightboxStore.getState().items.map(item => item.id)).toEqual(["b", "a"]);
		useProjectStore.getState().updateShot("ep", "shot", { materials: [material("a")] });
		expect(useLightboxStore.getState().item?.id).toBe("a");
	});

	it("迟到打开、缺失素材和空 URI 不打开无关素材", () => {
		seed([material("a"), material("upload", "image", "")]);
		openShotMaterialLightbox("ep", "shot", "a", { owner: "old-owner" });
		expect(useLightboxStore.getState().item).toBeNull();
		openShotMaterialLightbox("ep", "shot", "missing");
		openShotMaterialLightbox("ep", "shot", "upload");
		expect(useLightboxStore.getState().item).toBeNull();
	});

	it("缺失、重复或未上传的排序身份不猜测写入", () => {
		seed([material("a"), material("b"), material("b"), material("upload", "image", "")]);
		const source = createShotMaterialLightboxSource("ep", "shot");
		expect(source.getItems()?.map(item => item.id)).toEqual(["a", "b"]);
		const before = liveShot();
		source.reorder!("b", "a");
		source.reorder!("upload", "a");
		source.reorder!("missing", "a");
		expect(liveShot()).toBe(before);
	});
});

describe("放大提示词中的灯箱重排", () => {
	const openDraft = (initial: string) => {
		let draft = initial;
		usePromptModalStore.getState().openPrompt({ value: initial, onSave: text => useProjectStore.getState().updateShot("ep", "shot", { unifiedPrompt: text }) });
		const api: PromptModalApi = { insertAtCursor: vi.fn(), getValue: () => draft, setValue: vi.fn(text => { draft = text; }) };
		return { api, text: () => draft, edit: (text: string) => { draft = text; }, sessionId: usePromptModalStore.getState().sessionId };
	};

	it("读取最新未保存正文与自定义图例，重映射仅更新草稿，后续显式保存不还原旧号", () => {
		seed([material("a"), material("b")], { unifiedPrompt: "已保存的 @Image1" });
		const draft = openDraft("最初 @Image1");
		openShotMaterialLightbox("ep", "shot", "b", { promptApi: draft.api, promptSessionId: draft.sessionId });
		draft.edit("【素材图例】@Image1 是 改名甲；@Image2 是 改名乙；\n\n未保存新增：@Image2 看向 @Image1");
		useLightboxStore.getState().reorder("b", "a");
		expect(draft.text()).toBe("【素材图例】@Image2 是 改名甲；@Image1 是 改名乙；\n\n未保存新增：@Image1 看向 @Image2");
		expect(liveShot().unifiedPrompt).toContain("已保存的 @Image2");
		expect(liveShot().unifiedPrompt).not.toContain("未保存新增");
		usePromptModalStore.getState().onSave!(draft.text());
		expect(liveShot().unifiedPrompt).toBe(draft.text());
	});

	it.each(["closed", "replaced"])("弹窗 %s 使旧画廊关闭并禁止迟到重排或草稿写入", reason => {
		const draft = openDraft("@Image1");
		openShotMaterialLightbox("ep", "shot", "b", { promptApi: draft.api, promptSessionId: draft.sessionId });
		const oldSource = useLightboxStore.getState().source!;
		if (reason === "closed") usePromptModalStore.getState().close();
		else usePromptModalStore.getState().openPrompt({ value: "新弹窗", onSave: vi.fn() });
		expect(useLightboxStore.getState().item).toBeNull();
		expect(oldSource.getItems()).toBeNull();
		oldSource.reorder!("b", "a");
		expect(liveShot().materials.map(item => item.id)).toEqual(["a", "b"]);
		expect(draft.api.setValue).not.toHaveBeenCalled();
		openShotMaterialLightbox("ep", "shot", "b", { promptApi: draft.api, promptSessionId: draft.sessionId });
		expect(useLightboxStore.getState().item).toBeNull();
	});

	it("排序订阅期间切换弹窗，不把旧草稿写进新会话", () => {
		const draft = openDraft("@Image1 未保存");
		const source = createShotMaterialLightboxSource("ep", "shot", { promptApi: draft.api, promptSessionId: draft.sessionId });
		const unsubscribe = useProjectStore.subscribe(() => usePromptModalStore.getState().openPrompt({ value: "新弹窗", onSave: vi.fn() }));
		try { source.reorder!("b", "a"); } finally { unsubscribe(); }
		expect(liveShot().materials.map(item => item.id)).toEqual(["b", "a"]);
		expect(draft.api.setValue).not.toHaveBeenCalled();
		expect(usePromptModalStore.getState().value).toBe("新弹窗");
	});

	it("只读或不能同步草稿的弹窗可以查看但不允许重排", () => {
		const draft = openDraft("@Image1");
		const source = createShotMaterialLightboxSource("ep", "shot", { promptApi: draft.api, promptSessionId: draft.sessionId });
		usePromptModalStore.setState({ readOnly: true });
		expect(source.getItems()).toHaveLength(2);
		expect(source.canReorder!()).toBe(false);
		source.reorder!("b", "a");
		usePromptModalStore.setState({ readOnly: false });
		const withoutWriter = createShotMaterialLightboxSource("ep", "shot", { promptApi: { insertAtCursor: vi.fn(), getValue: draft.api.getValue } });
		expect(withoutWriter.canReorder!()).toBe(false);
		withoutWriter.reorder!("b", "a");
		expect(liveShot().materials.map(item => item.id)).toEqual(["a", "b"]);
	});
});
