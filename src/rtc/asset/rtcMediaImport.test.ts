import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useLibraryStore } from "@/store/libraryStore";
import { captureRtcImportTarget, importRtcMediaFiles } from "./rtcMediaImport";

const { upload } = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("@/canvas/nodeUpload", () => ({
	uploadMediaToCanvasAsset: upload,
	uploadKindFromFile: (file: File) => file.type.startsWith("video/") ? "video" : "image",
}));
const episodes = ["a", "b"].map((id, index) => ({ id, index, title: id, shots: [], scriptText: "" }));
const file = { name: "movie.mp4", type: "video/mp4" } as File;
const uploaded = { assetId: "LC-one", displayUri: "blob:one", localPath: null };

describe("RTC 导入的原项目与分集归属", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		useProjectStore.setState({ projectInstanceId: "project-a", isProjectLoading: false, episodes, rtcEpisodeId: "a", assetBlobs: {} });
		useLibraryStore.setState({ assets: {} });
	});

	it("选择器打开后切项目，即使分集 ID 相同也不开始上传", async () => {
		const target = captureRtcImportTarget("a");
		useProjectStore.setState({ projectInstanceId: "project-b" });
		expect((await importRtcMediaFiles([file], target)).cancelled).toBe(true);
		expect(upload).not.toHaveBeenCalled();
	});

	it("上传完成前切项目，拒绝入库并终止剩余批次", async () => {
		upload.mockImplementationOnce(async (_file, _prefix, opts) => {
			expect(opts.shouldContinue()).toBe(true);
			useProjectStore.setState({ projectInstanceId: "project-b" });
			expect(opts.shouldContinue()).toBe(false);
			return uploaded;
		});
		const result = await importRtcMediaFiles([file, file], captureRtcImportTarget("a"));
		expect(result).toMatchObject({ done: 0, cancelled: true });
		expect(upload).toHaveBeenCalledTimes(1);
		expect(useLibraryStore.getState().assets).toEqual({});
	});

	it("只切换当前分集时仍将素材写回原分集", async () => {
		upload.mockImplementationOnce(async () => {
			useProjectStore.setState({ rtcEpisodeId: "b" });
			return uploaded;
		});
		expect(await importRtcMediaFiles([file], captureRtcImportTarget("a"))).toEqual({ done: 1, firstKind: "video", cancelled: false });
		expect(useLibraryStore.getState().assets[uploaded.assetId].episodeId).toBe("a");
	});

	it("原分集删除后不登记孤立素材，不显示过期失败消息", async () => {
		const onError = vi.fn();
		upload.mockImplementationOnce(async () => {
			useProjectStore.setState({ episodes: episodes.filter((e) => e.id !== "a") });
			throw new Error("cancelled");
		});
		expect((await importRtcMediaFiles([file], captureRtcImportTarget("a"), { onError })).cancelled).toBe(true);
		expect(onError).not.toHaveBeenCalled();
		expect(useLibraryStore.getState().assets).toEqual({});
	});

	it("单个文件失败后继续原批次，并报告实际失败", async () => {
		const onError = vi.fn();
		upload.mockRejectedValueOnce(new Error("read failed")).mockResolvedValueOnce(uploaded);
		expect((await importRtcMediaFiles([file, file], captureRtcImportTarget("a"), { onError })).done).toBe(1);
		expect(onError).toHaveBeenCalledTimes(1);
	});
});
