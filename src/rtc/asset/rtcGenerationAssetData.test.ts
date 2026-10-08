import { describe, expect, it } from "vitest";
import type { PendingGen } from "@/services/projectFile";
import { collectGenerationAssetItems, type FreeGenerationAssetSource } from "./rtcGenerationAssetData";
import { collectLibraryImageItems, collectVideoItems, filterByQuery } from "./rtcAssetData";
import type { Asset as LibraryAsset } from "@/store/libraryStore";

const pending = (patch: Partial<PendingGen> = {}): PendingGen => ({
	id: "shot-video", purpose: "video", prompt: "", label: "分镜一", status: "running", createdAt: 1,
	shot: { episodeId: "ep1", shotId: "shot1", field: "video" }, ...patch,
});
const free = (patch: Partial<FreeGenerationAssetSource> = {}): FreeGenerationAssetSource => ({
	id: "free-video", target: { episodeId: "ep1" }, media: "video", name: "自由片段", status: "running", createdAt: 2, ...patch,
});
const collect = (pendingGens: PendingGen[], freeTasks: FreeGenerationAssetSource[] = [], media: "image" | "video" = "video") =>
	collectGenerationAssetItems({ pendingGens, freeTasks, episodeId: "ep1", media });

describe("collectGenerationAssetItems", () => {
	it("只收当前分集、当前媒体；不把文本推理或项目资产生成当成媒体任务", () => {
		const tasks = [
			pending(),
			pending({ id: "image", shot: { episodeId: "ep1", shotId: "s2", field: "storyboard" } }),
			pending({ id: "other-episode", shot: { episodeId: "ep2", shotId: "s3", field: "video" } }),
			pending({ id: "video-prompt", shot: { episodeId: "ep1", shotId: "s1", field: "videoPrompt" } }),
			pending({ id: "image-prompt", shot: { episodeId: "ep1", shotId: "s1", field: "storyboardPrompt" } }),
			pending({ id: "character", shot: undefined, cat: "characters", assetId: "C1" }),
		];
		expect(collect(tasks).map(item => item.key)).toEqual(["generation:shot:shot-video"]);
		expect(collect(tasks, [], "image").map(item => item.key)).toEqual(["generation:shot:image"]);
	});

	it("派生媒体省略field默认视频，图片超分归图片且不要求原分镜/时间轨仍存在", () => {
		const tasks = [
			pending({ id: "derived-video", shot: undefined, label: "已删片段 · 超分", derived: { episodeId: "ep1", shotId: "deleted", recId: "d1" } }),
			pending({ id: "derived-image", shot: undefined, derived: { episodeId: "ep1", shotId: "deleted", recId: "d2", field: "storyboard" } }),
		];
		expect(collect(tasks)[0]).toMatchObject({ name: "已删片段 · 超分", media: "video", uri: "" });
		expect(collect(tasks, [], "image")[0].key).toBe("generation:shot:derived-image");
	});

	it("自由生成按分集/模态过滤并与分镜任务交错按新到旧排列", () => {
		const result = collect([pending()], [free(), free({ id: "free-image", media: "image" }),
			free({ id: "free-audio", media: "audio" }), free({ id: "other", target: { episodeId: "ep2" } })]);
		expect(result.map(item => item.key)).toEqual(["generation:free:free-video", "generation:shot:shot-video"]);
		expect(result.every(item => item.uri === "" && !item.placeholder && item.generation)).toBe(true);
	});

	it("同分镜并发任务与不同来源同ID各自成卡，不以分镜名合并", () => {
		const result = collect([pending(), pending({ id: "shot-video-2", createdAt: 3 })], [free({ id: "shot-video" })]);
		expect(result.map(item => item.key)).toEqual(["generation:shot:shot-video-2", "generation:free:shot-video", "generation:shot:shot-video"]);
	});

	it("无进度不伪造0%，会话进度更新显示百分比/排队/阶段", () => {
		expect(collect([pending()])[0].generation?.label).toBe("生成中…");
		const render = (progress: number, extra?: { queuePosition?: number; queueTotal?: number; stageText?: string }) =>
			collectGenerationAssetItems({ pendingGens: [pending()], freeTasks: [], episodeId: "ep1", media: "video", getProgress: () => ({ progress, extra }) })[0].generation?.label;
		expect(render(37)).toBe("生成中 37%");
		expect(render(37, { queuePosition: 2, queueTotal: 6 })).toBe("排队中 · 第 2/6 位");
		expect(render(37, { stageText: "上传素材中" })).toBe("上传素材中");
		expect(collect([], [free({ progress: 64 })])[0].generation?.label).toBe("生成中 64%");
	});

	it("失败任务保留完整错误，不回退到正在生成或丢失名称", () => {
		const error = "渠道暂不可用，请重连原任务：request-123";
		const result = collect([pending({ status: "failed", error, recoverable: true })], [free({ status: "failed", error })]);
		expect(result).toHaveLength(2);
		expect(result.every(item => item.generation?.status === "failed" && item.generation.error === error && item.generation.label === "生成失败")).toBe(true);
		expect(filterByQuery(result, "分镜一")).toHaveLength(1);
	});

	it("自由生成提交准备、保存中与分镜持有结果待保存使用明确状态", () => {
		expect(collect([], [free({ status: "preparing" })])[0].generation?.label).toBe("准备中…");
		expect(collect([], [free({ status: "saving" })])[0].generation?.label).toBe("保存中…");
		const result = collect([pending({ rtcResult: { uri: "https://result/video.mp4", media: "video" } })]);
		expect(result[0]).toMatchObject({ uri: "", generation: { status: "saving", label: "保存中…" } });
	});

	it("完成任务退出后由已登记素材接替，图片/视频无需时间轨或分镜存在", () => {
		const image: LibraryAsset = { id: "image-result", name: "分镜一", kind: "image", uri: "local://result.png", origin: "generated", episodeId: "ep1", createdAt: "", thumbnailUri: null, deletedByUser: false };
		const video: LibraryAsset = { ...image, id: "video-result", kind: "video", uri: "local://result.mp4" };
		expect(collect([], [], "image")).toEqual([]);
		expect(collectLibraryImageItems([image], { includeGenerated: true })[0]).toMatchObject({ key: "image-result", uri: "local://result.png" });
		expect(collect([], [])).toEqual([]);
		expect(collectVideoItems([], [video], () => undefined)[0]).toMatchObject({ key: "video-result", uri: "local://result.mp4" });
	});
});
