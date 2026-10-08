import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptModalApi } from "@/store/promptModalStore";

const h = vi.hoisted(() => ({ state: {} as any, rtc: {} as any, upload: vi.fn(), writes: vi.fn() }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.state } }));
vi.mock("@/store/rtcStore", () => ({ useRtcStore: { getState: () => h.rtc }, activeRtcDoc: (state: any) => state.doc }));
vi.mock("@/store/connectionStore", () => ({ getDualModeFeature: () => true }));
vi.mock("@/canvas/nodeUpload", () => ({ uploadMediaToCanvasAsset: h.upload }));

import { addLocalShotMaterials } from "@/lib/shotMaterialOps";
import { QIJI_ASSET_MIME } from "@/lib/promptMediaDrop";
import { useUploadStore } from "@/store/uploadStore";
import { useRtcFreeGenStore } from "./rtcFreeGenStore";
import { addLocalFreeGenRefs, freePromptMediaDrop, shotPromptMediaDrop } from "./rtcPromptDrop";

const file = (name: string, type = "image/png") => new File([name], name, { type });
const data = (values: Record<string, string> = {}, files: File[] = []) => ({ getData: (key: string) => values[key] || "", files, types: Object.keys(values) }) as unknown as DataTransfer;
const asset = (name: string, extra: Record<string, unknown> = {}, plain = false) => data({ [plain ? "text/plain" : QIJI_ASSET_MIME]: JSON.stringify({ source: "qiji-asset", assetId: name, localUri: `local://${name}`, name, kind: "image", ...extra }) });
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const shot = () => h.state.episodes[0].shots[0];
const refs = () => useRtcFreeGenStore.getState().draftOf("seg").refs;
function deferredUpload() {
	let resolve!: (value: { assetId: string; displayUri: string }) => void, reject!: (error: Error) => void;
	h.upload.mockImplementationOnce(() => new Promise((res, rej) => { resolve = res; reject = rej; }));
	return { resolve: (name = "uploaded") => resolve({ assetId: name, displayUri: `local://${name}` }), reject: () => reject(new Error("upload failed")) };
}
function project(owner = "project-A") {
	return {
		projectInstanceId: owner, isProjectLoading: false, mediaSettings: { imgVideoSameSource: false },
		episodes: [{ id: "ep", shots: [{ id: "shot", materials: [], videoPrompt: "原视频正文", storyboardPrompt: "原图片正文", unifiedPrompt: "同源正文" }] }],
		updateShot: (epId: string, shotId: string, patch: any) => {
			h.writes(h.state.projectInstanceId, epId, shotId, patch);
			const current = h.state.episodes.find((ep: any) => ep.id === epId)?.shots.find((item: any) => item.id === shotId);
			if (current) Object.assign(current, patch);
		},
	};
}
beforeEach(() => {
	h.state = project(); h.rtc = { ownerProjectId: "project-A", editingSubDocId: undefined, doc: { id: "doc-A", tracks: [{ id: "track", segments: [{ id: "seg", kind: "placeholder" }] }] } };
	h.upload.mockReset().mockImplementation(async (uploaded: File) => ({ assetId: uploaded.name, displayUri: `local://${uploaded.name}` })); h.writes.mockReset();
	useRtcFreeGenStore.setState({ drafts: {} }); useUploadStore.setState({ pending: {} });
});
afterEach(() => vi.restoreAllMocks());

describe("RTC prompt drops use real shot material operations", () => {
	it("adds an asset as material with category/default identity and preserves body text rather than inserting JSON", () => {
		expect(shotPromptMediaDrop("ep", "shot", "videoPrompt")(asset("李四", { cat: "characters" }))).toBe(true);
		expect(shot().materials).toHaveLength(1);
		expect(shot().materials[0]).toMatchObject({ assetId: "李四", uri: "local://李四", kind: "character", media: "image", usage: "identity" });
		expect(shot().videoPrompt).toBe("【素材图例】@Image1 是 李四；\n\n原视频正文");
		expect(shot().storyboardPrompt).toBe("【素材图例】@Image1 是 李四；\n\n原图片正文");
		expect(shot().videoPrompt).not.toContain("qiji-asset"); expect(h.upload).not.toHaveBeenCalled();
	});
	it("supports the plain-text asset fallback and deduplicates by asset ID or display URI", () => {
		const drop = shotPromptMediaDrop("ep", "shot");
		drop(asset("甲", {}, true)); drop(asset("甲", { localUri: "local://other-copy" })); drop(asset("other-id", { localUri: "local://甲" }));
		expect(shot().materials).toHaveLength(1); expect(h.writes).toHaveBeenCalledTimes(1);
	});
	it("keeps existing custom legend labels and inline body references when another image is dropped", () => {
		const drop = shotPromptMediaDrop("ep", "shot", "videoPrompt"); drop(asset("甲"));
		shot().videoPrompt = "【素材图例】@Image1 是 自定义甲；\n\n@Image1 走进房间";
		drop(asset("乙"));
		expect(shot().videoPrompt).toBe("【素材图例】@Image1 是 自定义甲；@Image2 是 乙；\n\n@Image1 走进房间");
	});
	it("merges new material into the modal's unsaved draft while retaining the independently saved host body", () => {
		shotPromptMediaDrop("ep", "shot")(asset("甲"));
		let draft = "【素材图例】@Image1 是 模态框自定义甲；\n\n未保存正文 @Image1";
		const api: PromptModalApi = { insertAtCursor: vi.fn(), getValue: () => draft, setValue: value => { draft = value; } };
		shotPromptMediaDrop("ep", "shot", "videoPrompt")(asset("乙"), api);
		expect(draft).toBe("【素材图例】@Image1 是 模态框自定义甲；@Image2 是 乙；\n\n未保存正文 @Image1");
		expect(shot().videoPrompt).toContain("原视频正文"); expect(shot().videoPrompt).not.toContain("未保存正文");
	});
	it("reads the latest modal draft after an upload instead of overwriting edits made while it was pending", async () => {
		const pending = deferredUpload(); let draft = "拖入时正文";
		const api: PromptModalApi = { insertAtCursor: vi.fn(), getValue: () => draft, setValue: value => { draft = value; } };
		expect(shotPromptMediaDrop("ep", "shot", "storyboardPrompt")(data({}, [file("参考.png")]), api)).toBe(true);
		draft = "上传中继续修改的正文"; pending.resolve("参考"); await flush();
		expect(draft).toBe("【素材图例】@Image1 是 参考；\n\n上传中继续修改的正文");
		expect(shot().storyboardPrompt).toContain("原图片正文");
	});
	it("filters files and preserves video/audio kinds while the storyboard legend remains image-only", async () => {
		shotPromptMediaDrop("ep", "shot")(data({}, [file("参考.png"), file("忽略.pdf", "application/pdf"), file("参考.mp4", "video/mp4"), file("参考.wav", "audio/wav")])); await flush();
		expect(h.upload.mock.calls.map(call => call[0].name)).toEqual(["参考.png", "参考.mp4", "参考.wav"]);
		expect(shot().materials.map((material: any) => material.media)).toEqual(["image", "video", "audio"]);
		expect(shot().videoPrompt).toContain("@Video1"); expect(shot().storyboardPrompt).not.toContain("@Video1");
	});
	it("does not consume ordinary text/capsules, and consumes stale-owner media without writing to the copied project", () => {
		const drop = shotPromptMediaDrop("ep", "shot");
		expect(drop(data({ "text/plain": "【预设:cinematic】" }))).toBe(false);
		expect(drop(data({ "text/plain": "拖入正文" }))).toBe(false);
		h.state = project("project-B"); expect(drop(asset("甲"))).toBe(true);
		expect(shot().materials).toEqual([]); expect(h.writes).not.toHaveBeenCalled(); expect(h.upload).not.toHaveBeenCalled();
	});
	it("stops the whole multi-file shot upload when project switching makes its first upload fail", async () => {
		const pending = deferredUpload(), upload = addLocalShotMaterials("ep", "shot", [file("first.png"), file("second.png")]);
		const guard = h.upload.mock.calls[0][2].shouldContinue; expect(guard()).toBe(true);
		h.state = project("project-B"); expect(guard()).toBe(false); pending.reject(); await upload;
		expect(h.upload).toHaveBeenCalledTimes(1); expect(shot().materials).toEqual([]); expect(h.writes).not.toHaveBeenCalled(); expect(useUploadStore.getState().pending).toEqual({});
	});
	it("stops after a target is deleted during a successful shot upload", async () => {
		const pending = deferredUpload(), upload = addLocalShotMaterials("ep", "shot", [file("first.png"), file("second.png")]);
		h.state.episodes[0].shots = []; pending.resolve(); await upload;
		expect(h.upload).toHaveBeenCalledTimes(1); expect(h.writes).not.toHaveBeenCalled(); expect(useUploadStore.getState().pending).toEqual({});
	});
	it("continues remaining files after an ordinary failure in the same project", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {}); h.upload.mockRejectedValueOnce(new Error("first failed"));
		await addLocalShotMaterials("ep", "shot", [file("first.png"), file("second.png")]);
		expect(h.upload).toHaveBeenCalledTimes(2); expect(shot().materials).toHaveLength(1); expect(shot().materials[0].name).toBe("second"); expect(useUploadStore.getState().pending).toEqual({});
	});
});

describe("RTC free prompt material ownership and concurrent appends", () => {
	it("appends to current refs and deduplicates repeated asset drops without changing the prompt", () => {
		useRtcFreeGenStore.getState().patch("seg", { prompt: "自由正文" }); const drop = freePromptMediaDrop("seg");
		drop(asset("甲")); drop(asset("乙", { kind: "video" }, true)); drop(asset("甲", { localUri: "local://alias" })); drop(asset("duplicate", { localUri: "local://乙" }));
		expect(refs().map(ref => [ref.assetId, ref.media])).toEqual([["甲", "image"], ["乙", "video"]]); expect(useRtcFreeGenStore.getState().draftOf("seg").prompt).toBe("自由正文");
		expect(drop(data({ "text/plain": "@Image1" }))).toBe(false);
	});
	it("preserves concurrent upload completions and synchronous drops instead of using stale refs", async () => {
		const first = deferredUpload(), second = deferredUpload();
		const one = addLocalFreeGenRefs("seg", [file("one.png")]);
		await vi.waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1), { interval: 5 });
		const two = addLocalFreeGenRefs("seg", [file("two.png")]);
		await vi.waitFor(() => expect(h.upload).toHaveBeenCalledTimes(2), { interval: 5 });
		freePromptMediaDrop("seg")(asset("between")); second.resolve("two"); await two; first.resolve("one"); await one;
		expect(refs().map(ref => ref.assetId)).toEqual(["between", "two", "one"]);
	});
	it("does not begin a free file upload if the project switches during the dynamic import", async () => {
		const pending = addLocalFreeGenRefs("seg", [file("first.png")]); h.state = project("project-B"); h.rtc.ownerProjectId = "project-B"; await pending;
		expect(h.upload).not.toHaveBeenCalled(); expect(refs()).toEqual([]);
	});
	it("does not upload the next file or append into project B after the first free upload rejects across a switch", async () => {
		const pending = deferredUpload(), work = addLocalFreeGenRefs("seg", [file("first.png"), file("second.png")]);
		await vi.waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1), { interval: 5 });
		const guard = h.upload.mock.calls[0][2].shouldContinue; expect(guard()).toBe(true);
		h.state = project("project-B"); h.rtc.ownerProjectId = "project-B"; expect(guard()).toBe(false); pending.reject(); await work;
		expect(h.upload).toHaveBeenCalledTimes(1); expect(refs()).toEqual([]);
	});
	it.each(["delete", "episode", "subdocument"])("stops a free file upload after its target context changes: %s", async (change) => {
		const pending = deferredUpload(), work = addLocalFreeGenRefs("seg", [file("first.png"), file("second.png")]);
		await vi.waitFor(() => expect(h.upload).toHaveBeenCalledTimes(1), { interval: 5 });
		if (change === "delete") h.rtc.doc.tracks[0].segments = [];
		else if (change === "episode") h.rtc = { ...h.rtc, doc: { ...h.rtc.doc, id: "doc-B" } };
		else h.rtc = { ...h.rtc, editingSubDocId: "sub-B" };
		pending.resolve(); await work;
		expect(h.upload).toHaveBeenCalledTimes(1); expect(refs()).toEqual([]);
	});
	it("an old free drop callback cannot modify a same-ID segment in a different project", () => {
		const drop = freePromptMediaDrop("seg"); h.state = project("project-B"); h.rtc.ownerProjectId = "project-B";
		expect(drop(asset("late"))).toBe(true); expect(refs()).toEqual([]);
	});
});
