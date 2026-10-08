import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RtcDoc } from "@/types/rtc";

const h = vi.hoisted(() => ({ project: {} as any, rtc: {} as any, upload: vi.fn(), probe: vi.fn(), addAsset: vi.fn(), commit: vi.fn(), select: vi.fn() }));
vi.mock("@/store/projectStore", () => ({
	useProjectStore: { getState: () => h.project },
	resolveEpisodeKey: (id: string, episodes: { id: string }[]) => episodes.some((e) => e.id === id) ? id : episodes[0]?.id ?? "",
}));
vi.mock("@/store/rtcStore", () => ({ useRtcStore: { getState: () => h.rtc } }));
vi.mock("@/store/libraryStore", () => ({ useLibraryStore: { getState: () => ({ addAsset: h.addAsset }) } }));
vi.mock("@/canvas/nodeUpload", () => ({
	uploadMediaToCanvasAsset: h.upload,
	uploadKindFromFile: (file: File) => file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : "script",
}));
vi.mock("./timelineUtil", async (importOriginal) => ({ ...await importOriginal<typeof import("./timelineUtil")>(), probeMediaDurationSec: h.probe }));
import { importDroppedFiles, placeDroppedAsset, replaceSegmentWithAsset } from "./rtcDropActions";

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}
const file = (name: string, type = "video/mp4") => new File(["fixture"], name, { type });
const media = { media: "video" as const, assetId: "video-1", displayUri: "asset://video-1", probeUri: "asset://video-1" };
function doc(id = "timeline-A"): RtcDoc { return { id, name: id, fps: 30, tracks: [{ id: "track", type: "video", segments: [] }] }; }
function switchEpisode() {
	h.project.rtcEpisodeId = "ep-B";
	h.rtc.ownerEpisodeKey = "ep-B";
	h.rtc.doc = doc("timeline-B");
}

beforeEach(() => {
	vi.clearAllMocks();
	h.project = { projectInstanceId: "project-A", rtcEpisodeId: "ep-A", episodes: [{ id: "ep-A" }, { id: "ep-B" }], isProjectLoading: false };
	h.rtc = { doc: doc(), ownerProjectId: "project-A", ownerEpisodeKey: "ep-A", editingSubDocId: null, snapOn: false, pxPerSec: 80, commitActive: h.commit, setSelection: h.select };
	h.commit.mockImplementation((mutator) => {
		const subId = h.rtc.editingSubDocId;
		if (subId) {
			const sub = h.rtc.doc.subDocs[subId];
			const next = mutator({ ...sub, fps: h.rtc.doc.fps });
			h.rtc.doc = { ...h.rtc.doc, subDocs: { ...h.rtc.doc.subDocs, [subId]: next } };
		} else h.rtc.doc = mutator(h.rtc.doc);
	});
	h.upload.mockImplementation(async (f: File) => ({ assetId: f.name, displayUri: `asset://${f.name}`, localPath: `A/assets/${f.name}` }));
	h.probe.mockResolvedValue(3);
});
afterEach(() => vi.restoreAllMocks());

describe("RTC 拖入的批次与落点归属", () => {
	it("第一文件上传期间切项目：取消整批，不继续给新项目导入第二文件", async () => {
		const upload = deferred<any>(); h.upload.mockReturnValueOnce(upload.promise);
		const pending = importDroppedFiles([file("one.mp4"), file("two.mp4")], 0);
		const guard = h.upload.mock.calls[0][2].shouldContinue;
		h.project = { ...h.project, projectInstanceId: "project-B" };
		h.rtc = { ...h.rtc, ownerProjectId: "project-B", doc: doc("timeline-B") };
		expect(guard()).toBe(false);
		upload.reject(new Error("项目或导入目标已变化"));
		await pending;
		expect(h.upload).toHaveBeenCalledTimes(1);
		expect(h.addAsset).not.toHaveBeenCalled();
		expect(h.commit).not.toHaveBeenCalled();
	});

	it("时长探测期间切集：不落到新集，不再处理后续文件，已登记素材保留原集归属", async () => {
		const probe = deferred<number>(); h.probe.mockReturnValueOnce(probe.promise);
		const pending = importDroppedFiles([file("one.mp4"), file("two.mp4")], 0);
		await vi.waitFor(() => expect(h.probe).toHaveBeenCalledTimes(1));
		switchEpisode(); probe.resolve(3); await pending;
		expect(h.upload).toHaveBeenCalledTimes(1);
		expect(h.addAsset).toHaveBeenCalledTimes(1);
		expect(h.addAsset.mock.calls[0][0]).toMatchObject({ episodeId: "ep-A", id: "one.mp4" });
		expect(h.commit).not.toHaveBeenCalled();
		expect(h.select).not.toHaveBeenCalled();
	});

	it.each(["切集", "更换文档", "进入复合", "删除分集"])("内部素材探测期间%s，不写入新目标", async (change) => {
		const probe = deferred<number>(); h.probe.mockReturnValueOnce(probe.promise);
		const pending = placeDroppedAsset(media, 0);
		if (change === "切集") switchEpisode();
		if (change === "更换文档") h.rtc.doc = doc("new-doc");
		if (change === "进入复合") { h.rtc.editingSubDocId = "sub"; h.rtc.doc.subDocs = { sub: { id: "sub", name: "sub", tracks: [] } }; }
		if (change === "删除分集") h.project.episodes = [{ id: "ep-B" }];
		probe.resolve(3);
		expect(await pending).toBe(false);
		expect(h.commit).not.toHaveBeenCalled();
	});

	it("正常两文件继续落库和入轨，保持真实时长、源窗口以及一次一条 undo", async () => {
		await importDroppedFiles([file("one.mp4"), file("two.mp4")], 1_000_000);
		expect(h.addAsset).toHaveBeenCalledTimes(2);
		expect(h.commit).toHaveBeenCalledTimes(2);
		const segments = h.rtc.doc.tracks[0].segments;
		expect(segments).toHaveLength(2);
		expect(segments[0]).toMatchObject({ assetId: "one.mp4", targetStartUs: 1_000_000, targetDurationUs: 3_000_000, sourceStartUs: 0, sourceDurationUs: 3_000_000 });
		expect(segments[1].targetStartUs).toBeGreaterThanOrEqual(segments[0].targetStartUs + segments[0].targetDurationUs);
	});

	it("正常单文件错误仍继续余下文件", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		h.upload.mockRejectedValueOnce(new Error("invalid media"));
		await importDroppedFiles([file("bad.mp4"), file("good.mp4")], 0);
		expect(h.upload).toHaveBeenCalledTimes(2);
		expect(h.addAsset).toHaveBeenCalledTimes(1);
		expect(h.rtc.doc.tracks[0].segments[0].assetId).toBe("good.mp4");
	});

	it("复合子层未切换时正常入子层，退出后旧探测不写主层", async () => {
		h.rtc.editingSubDocId = "sub";
		h.rtc.doc.subDocs = { sub: { id: "sub", name: "sub", tracks: [] } };
		expect(await placeDroppedAsset({ media: "image", assetId: "image-1", displayUri: "asset://image-1" }, 0)).toBe(true);
		expect(h.rtc.doc.tracks[0].segments).toHaveLength(0);
		expect(h.rtc.doc.subDocs.sub.tracks[0].segments).toHaveLength(1);
		const probe = deferred<number>(); h.probe.mockReturnValueOnce(probe.promise);
		const pending = placeDroppedAsset(media, 0);
		h.rtc.editingSubDocId = null; probe.resolve(3);
		expect(await pending).toBe(false);
		expect(h.commit).toHaveBeenCalledTimes(1);
	});

	it("原位替换的时长探测同样绑定编辑目标", async () => {
		const probe = deferred<number>(); h.probe.mockReturnValueOnce(probe.promise);
		const pending = replaceSegmentWithAsset("existing-seg", media);
		switchEpisode(); probe.resolve(3); await pending;
		expect(h.commit).not.toHaveBeenCalled();
		expect(h.select).not.toHaveBeenCalled();
	});
});
