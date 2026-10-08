import { readPromptMediaDrop, type PromptMediaDropHandler } from "@/lib/promptMediaDrop";
import { addLocalShotMaterials, addShotMaterialFromAsset, materialKindFromAssetCat } from "@/lib/shotMaterialOps";
import { applyLegend, buildLegend } from "@/lib/shotMaterials";
import { useProjectStore } from "@/store/projectStore";
import type { PromptModalApi } from "@/store/promptModalStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import { useRtcFreeGenStore, type FreeGenRef } from "./rtcFreeGenStore";
import type { ShotPromptFieldKey } from "./shotMatchActions";

/** 在宿主渲染时冻结归属，放大编辑器打开后切项目也不能写入同名分镜。 */
export function shotPromptMediaDrop(episodeId: string, shotId: string, field?: ShotPromptFieldKey) {
	const owner = useProjectStore.getState().projectInstanceId;
	const live = () => {
		const state = useProjectStore.getState();
		return state.projectInstanceId === owner && !state.isProjectLoading
			? state.episodes.find((ep) => ep.id === episodeId)?.shots.find((shot) => shot.id === shotId) : undefined;
	};
	return (transfer: DataTransfer, api?: PromptModalApi): boolean => {
		const drop = readPromptMediaDrop(transfer);
		if (!drop) return false;
		if (!live()) return true;
		const refreshDraft = () => {
			const shot = live();
			if (api?.getValue && api.setValue && shot && field) api.setValue(applyLegend(api.getValue(), buildLegend(shot.materials, field === "storyboardPrompt")));
		};
		if ("asset" in drop) {
			addShotMaterialFromAsset(episodeId, shotId, { ...drop.asset, kind: materialKindFromAssetCat(drop.asset.cat) });
			refreshDraft();
		} else void addLocalShotMaterials(episodeId, shotId, drop.files).then(refreshDraft);
		return true;
	};
}

function freeTargetCurrent(segId: string) {
	const owner = useProjectStore.getState().projectInstanceId;
	const rtc = useRtcStore.getState();
	const doc = activeRtcDoc(rtc);
	return () => {
		const project = useProjectStore.getState(), currentRtc = useRtcStore.getState();
		const currentDoc = activeRtcDoc(currentRtc);
		return project.projectInstanceId === owner && !project.isProjectLoading && currentRtc.ownerProjectId === owner
			&& currentDoc?.id === doc?.id && currentRtc.editingSubDocId === rtc.editingSubDocId
			&& !!currentDoc?.tracks.some((track) => track.segments.some((seg) => seg.id === segId));
	};
}

function appendFreeRefs(segId: string, added: FreeGenRef[]) {
	const store = useRtcFreeGenStore.getState();
	const refs = [...store.draftOf(segId).refs];
	for (const ref of added) if (!refs.some((old) => old.uri === ref.uri || (!!ref.assetId && old.assetId === ref.assetId))) refs.push(ref);
	store.patch(segId, { refs });
}

export async function addLocalFreeGenRefs(segId: string, files: File[]): Promise<void> {
	const current = freeTargetCurrent(segId);
	if (!files.length || !current()) return;
	const { uploadMediaToCanvasAsset } = await import("@/canvas/nodeUpload");
	for (const file of files) {
		if (!current()) return;
		try {
			const up = await uploadMediaToCanvasAsset(file, "TP", { shouldContinue: current });
			if (!current()) return;
			appendFreeRefs(segId, [{ uri: up.displayUri, assetId: up.assetId, name: file.name,
				media: file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "image" }]);
		} catch { if (!current()) return; }
	}
}

export function freePromptMediaDrop(segId: string): PromptMediaDropHandler {
	const current = freeTargetCurrent(segId);
	return (transfer) => {
		const drop = readPromptMediaDrop(transfer);
		if (!drop) return false;
		if (!current()) return true;
		if ("asset" in drop) appendFreeRefs(segId, [drop.asset]);
		else void addLocalFreeGenRefs(segId, drop.files);
		return true;
	};
}
