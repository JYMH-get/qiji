import { uploadKindFromFile, uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";

/** 在打开选择器时固定归属；切分集不改变归属，切项目或删除原分集则取消。 */
export function captureRtcImportTarget(episodeId: string) {
	const projectInstanceId = useProjectStore.getState().projectInstanceId;
	return {
		episodeId,
		isCurrent: () => {
			const s = useProjectStore.getState();
			return s.projectInstanceId === projectInstanceId && !s.isProjectLoading
				&& (!episodeId || s.episodes.some((e) => e.id === episodeId));
		},
	};
}

/** 同一个批次始终写原分集；将同一守卫传入底层，阻止过期操作落盘和登记映射。 */
export async function importRtcMediaFiles(
	files: File[],
	target: ReturnType<typeof captureRtcImportTarget>,
	options: { shouldContinue?: () => boolean; onError?: (file: File, error: unknown) => void } = {},
) {
	const current = () => target.isCurrent() && options.shouldContinue?.() !== false;
	let done = 0;
	let firstKind: "image" | "video" | "audio" | null = null;
	for (const file of files) {
		if (!current()) break;
		const kind = uploadKindFromFile(file);
		if (kind === "script") continue;
		try {
			const up = await uploadMediaToCanvasAsset(file, "TP", { shouldContinue: current });
			if (!current()) break;
			useLibraryStore.getState().addAsset({
				id: up.assetId, kind, name: file.name.replace(/\.[^.]+$/, ""), uri: up.displayUri,
				serverAssetId: up.assetId, thumbnailUri: kind === "image" ? up.displayUri : null,
				createdAt: new Date().toISOString(), deletedByUser: false, localPath: up.localPath,
				origin: "upload", episodeId: target.episodeId || null,
			});
			done++;
			firstKind ??= kind;
		} catch (error) {
			if (!current()) break;
			options.onError?.(file, error);
		}
	}
	return { done, firstKind, cancelled: !current() };
}
