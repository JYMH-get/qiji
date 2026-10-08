import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryStore } from "@/store/libraryStore";
const h = vi.hoisted(() => ({ project: {} as any }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.project } }));
import { registerRtcGeneratedAsset } from "./rtcGeneratedLibrary";

const args = { owner: "project-A", episodeId: "episode-A", taskKey: "shot:task-1", media: "video" as const,
	uri: "asset://result.mp4", assetId: "video-1", name: "分镜1·视频", createdAt: 123 };
beforeEach(() => {
	useLibraryStore.setState({ assets: {} });
	h.project = { projectInstanceId: "project-A", isProjectLoading: false, assetBlobs: {
		"video-1": { id: "video-1", localPath: "A/assets/video-1.mp4" },
	}, blobByUri: vi.fn(), markDirty: vi.fn() };
});

describe("generated RTC library results", () => {
	it("keeps original episode ownership and local mapping independently of a timeline", () => {
		expect(registerRtcGeneratedAsset(args)).toBe(true);
		expect(Object.values(useLibraryStore.getState().assets)).toEqual([expect.objectContaining({
			episodeId: "episode-A", kind: "video", uri: args.uri, origin: "generated", serverAssetId: "video-1",
			localPath: "A/assets/video-1.mp4", name: args.name, createdAt: new Date(123).toISOString(),
		})]);
		expect(h.project.markDirty).toHaveBeenCalledOnce();
	});
	it.each(["switched", "loading"])("rejects a %s project", state => {
		if (state === "switched") h.project.projectInstanceId = "project-B";
		else h.project.isProjectLoading = true;
		expect(registerRtcGeneratedAsset(args)).toBe(false);
		expect(useLibraryStore.getState().assets).toEqual({});
	});
	it("replay preserves one result and never resurrects its soft-deleted library entry", () => {
		registerRtcGeneratedAsset(args);
		const id = Object.keys(useLibraryStore.getState().assets)[0];
		useLibraryStore.getState().deleteAsset(id);
		expect(registerRtcGeneratedAsset({ ...args, name: "late name" })).toBe(true);
		expect(Object.values(useLibraryStore.getState().assets)).toEqual([expect.objectContaining({ deletedByUser: true, name: args.name })]);
	});
	it("keeps different task results separate and supplies image thumbnails", () => {
		registerRtcGeneratedAsset(args);
		registerRtcGeneratedAsset({ ...args, taskKey: "shot:task-2", media: "image", uri: "https://fixture.invalid/image.png", assetId: undefined });
		expect(Object.values(useLibraryStore.getState().assets)).toHaveLength(2);
		expect(Object.values(useLibraryStore.getState().assets)[1].thumbnailUri).toBe("https://fixture.invalid/image.png");
	});
});
