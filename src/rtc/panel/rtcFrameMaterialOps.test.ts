import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ state: {} as any, draft: {} as any, seg: {} as any }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.state } }));
vi.mock("@/store/connectionStore", () => ({ getDualModeFeature: () => true }));
vi.mock("@/canvas/nodeUpload", () => ({ uploadMediaToCanvasAsset: vi.fn() }));
vi.mock("@/store/uploadStore", () => ({ useUploadStore: {}, uploadKeys: {} }));
vi.mock("./rtcGenSink", () => ({ resolveRtcTarget: () => h.seg ? { episodeId: "episode", segId: "seg" } : null, liveSegment: () => h.seg }));
vi.mock("./rtcFreeGenStore", () => ({ useRtcFreeGenStore: { getState: () => ({ draftOf: () => h.draft, patch: (_id: string, patch: any) => Object.assign(h.draft, patch) }) } }));
import { setRtcFreeFrameMaterial, setRtcShotFrameMaterial } from "./rtcFrameMaterialOps";
import { splitLegendPrompt } from "@/lib/shotMaterials";
const shot = () => h.state.episodes[0].shots[0];
beforeEach(() => {
	h.state = { projectInstanceId: "owner", isProjectLoading: false, mediaSettings: { imgVideoSameSource: true }, episodes: [{ id: "episode", shots: [{ id: "shot", unifiedPrompt: "保留正文 @Image1", videoPrompt: "视频正文", materials: [{ id: "ordinary", kind: "local", media: "image", uri: "ref", name: "普通参考" }] }] }],
		updateShot: (_episode: string, _shot: string, patch: any) => Object.assign(shot(), patch) };
	h.seg = { id: "seg", kind: "placeholder" };
	h.draft = { prompt: "草稿正文 @Image1", refs: [{ uri: "ordinary", media: "image", name: "普通" }], modelKey: "model" };
});
describe("RTC frame insertion", () => {
	it("adds a role then replaces its existing slot, retaining body and other material descriptions", () => {
		expect(setRtcShotFrameMaterial("episode", "shot", "first", { uri: "first", name: "旧首帧" }, "owner")).toBe(true);
		const materialId = shot().materials[1].id;
		shot().unifiedPrompt = shot().unifiedPrompt.replace("普通参考", "用户写的参考说明");
		expect(setRtcShotFrameMaterial("episode", "shot", "last", { uri: "last", name: "尾帧" }, "owner")).toBe(true);
		expect(setRtcShotFrameMaterial("episode", "shot", "first", { uri: "new-first", name: "新首帧" }, "owner")).toBe(true);
		expect(shot().materials.map((ref: any) => ref.uri)).toEqual(["ref", "new-first", "last"]);
		expect(shot().materials[1].id).toBe(materialId);
		expect(shot().unifiedPrompt).toContain("用户写的参考说明"); expect(shot().unifiedPrompt).toContain("新首帧"); expect(shot().unifiedPrompt).not.toContain("旧首帧");
		expect(splitLegendPrompt(shot().unifiedPrompt).body).toBe("保留正文 @Image1");
		expect(shot().videoPrompt).toBe("视频正文");
	});
	it("free replacements preserve draft prompt, model and other references", () => {
		const ordinary = h.draft.refs[0];
		expect(setRtcFreeFrameMaterial("seg", "last", { uri: "last" }, "owner")).toBe(true);
		expect(setRtcFreeFrameMaterial("seg", "first", { uri: "first" }, "owner")).toBe(true);
		expect(setRtcFreeFrameMaterial("seg", "last", { uri: "new-last" }, "owner")).toBe(true);
		expect(h.draft.refs.map((ref: any) => ref.uri)).toEqual(["ordinary", "new-last", "first"]);
		expect(h.draft.refs[0]).toBe(ordinary); expect(h.draft.prompt).toBe("草稿正文 @Image1"); expect(h.draft.modelKey).toBe("model");
	});
	it("rejects late writes after project switching or target deletion", () => {
		expect(setRtcShotFrameMaterial("episode", "shot", "first", { uri: "first" }, "other-owner")).toBe(false);
		expect(setRtcFreeFrameMaterial("seg", "first", { uri: "first" }, "other-owner")).toBe(false);
		h.seg = null; h.state.episodes[0].shots = [];
		expect(setRtcShotFrameMaterial("episode", "shot", "first", { uri: "first" }, "owner")).toBe(false);
		expect(setRtcFreeFrameMaterial("seg", "first", { uri: "first" }, "owner")).toBe(false);
		expect(h.draft.refs).toHaveLength(1);
	});
});
