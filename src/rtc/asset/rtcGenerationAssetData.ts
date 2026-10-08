import type { PendingGen } from "@/services/projectFile";
import { progressLabel, type QueueExtra } from "@/lib/queueLabel";
import type { RtcAssetItem, RtcMedia } from "./rtcAssetData";

/** 自由生成凭据的只读投影；完成登记后的产物继续走现有素材库。 */
export interface FreeGenerationAssetSource {
	id: string;
	target: { episodeId: string };
	media: RtcMedia;
	name: string;
	status: "preparing" | "running" | "saving" | "failed";
	progress?: number | null;
	extra?: QueueExtra;
	error?: string;
	createdAt: number;
}

/** 当前分集的媒体任务，独立于 shot/segment 是否仍在时间轴中；每次提交独立成卡。 */
export function collectGenerationAssetItems({
	pendingGens, freeTasks, episodeId, media, getProgress,
}: {
	pendingGens: readonly PendingGen[];
	freeTasks: readonly FreeGenerationAssetSource[];
	episodeId: string;
	media: "image" | "video";
	getProgress?: (id: string) => { progress?: number | null; extra?: QueueExtra } | undefined;
}): RtcAssetItem[] {
	const tasks: Array<{ item: RtcAssetItem; createdAt: number }> = [];
	const add = (key: string, name: string, status: NonNullable<RtcAssetItem["generation"]>["status"],
		createdAt: number, progress?: number | null, extra?: QueueExtra, error?: string) => {
		const label = status === "failed" ? "生成失败" : status === "saving" ? "保存中…"
			: status === "preparing" ? "准备中…" : progressLabel(progress, extra);
		tasks.push({ createdAt, item: {
			key, uri: "", name: name.trim() || (media === "video" ? "视频生成" : "图片生成"),
			cat: media === "video" ? "videos" : "others", media,
			generation: { status, label, ...(error ? { error } : {}) },
		} });
	};
	for (const pending of pendingGens) {
		const target = pending.derived ?? pending.shot;
		if (!target || target.episodeId !== episodeId) continue;
		const field = pending.derived ? pending.derived.field ?? "video" : pending.shot?.field;
		const taskMedia = field === "storyboard" ? "image" : field === "video" ? "video" : undefined;
		if (taskMedia !== media) continue; // 提示词推理和五类资产生成不占素材卡位。
		const progress = getProgress?.(pending.id);
		const status = pending.status === "failed" ? "failed" : pending.rtcResult?.uri ? "saving" : "running";
		add(`generation:shot:${pending.id}`, pending.label, status, pending.createdAt, progress?.progress, progress?.extra, pending.error);
	}
	for (const task of freeTasks) {
		if (task.target.episodeId !== episodeId || task.media !== media) continue;
		add(`generation:free:${task.id}`, task.name, task.status, task.createdAt, task.progress, task.extra, task.error);
	}
	return tasks.sort((a, b) => b.createdAt - a.createdAt || a.item.key.localeCompare(b.item.key)).map(task => task.item);
}
