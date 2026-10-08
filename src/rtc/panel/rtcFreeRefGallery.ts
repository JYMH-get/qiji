import { remapBodyTags, TAG_KIND, type MediaKind } from "@/lib/shotMaterials";
import { moveGalleryItem } from "@/lib/materialGallery";
import { useProjectStore } from "@/store/projectStore";
import { activeRtcDoc, useRtcStore } from "@/store/rtcStore";
import type { LightboxGallerySource } from "@/store/lightboxStore";
import { useRtcFreeGenStore, type FreeGenRef } from "./rtcFreeGenStore";
import { freeGenBusy } from "./freeGenActions";

export function reorderFreeRefs(refs: FreeGenRef[], prompt: string, fromId: string, toId: string, idOf: (ref: FreeGenRef) => string) {
	const next = moveGalleryItem(refs, fromId, toId, idOf);
	if (!next) return null;
	const tags = (items: FreeGenRef[]) => {
		const count: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
		return new Map(items.map(item => [idOf(item), `@${TAG_KIND[item.media]}${++count[item.media]}`]));
	};
	const before = tags(refs), after = tags(next);
	const mapping = Object.fromEntries([...before].map(([id, tag]) => [tag, after.get(id)!]));
	return { refs: next, prompt: remapBodyTags(prompt, mapping) };
}

export function freeRefGallery(segId: string, idOf: (ref: FreeGenRef) => string): LightboxGallerySource {
	const owner = useProjectStore.getState().projectInstanceId;
	const rtc = useRtcStore.getState(), docId = activeRtcDoc(rtc)?.id;
	const live = () => {
		const project = useProjectStore.getState(), now = useRtcStore.getState(), doc = activeRtcDoc(now);
		if (project.isProjectLoading || project.projectInstanceId !== owner || now.ownerProjectId !== owner
			|| now.ownerEpisodeKey !== rtc.ownerEpisodeKey || now.editingSubDocId !== rtc.editingSubDocId || doc?.id !== docId) return null;
		const track = doc?.tracks.find(track => track.segments.some(seg => seg.id === segId));
		const seg = track?.segments.find(seg => seg.id === segId);
		return seg && track ? { seg, track } : null;
	};
	const canReorder = () => { const target = live(); return !!target && !target.track.locked && target.seg.kind === "placeholder" && target.seg.status !== "running" && !freeGenBusy(segId); };
	return {
		getItems: () => {
			if (!live()) return null;
			const count: Record<MediaKind, number> = { image: 0, video: 0, audio: 0 };
			const label: Record<MediaKind, string> = { image: "图片", video: "视频", audio: "音频" };
			return useRtcFreeGenStore.getState().draftOf(segId).refs.map(ref => ({
				id: idOf(ref), uri: ref.uri, media: ref.media, name: ref.name, label: `${label[ref.media]}${++count[ref.media]}`,
			}));
		},
		subscribe: listener => {
			const stops = [useProjectStore.subscribe(listener), useRtcStore.subscribe(listener), useRtcFreeGenStore.subscribe(listener)];
			return () => stops.forEach(stop => stop());
		},
		canReorder,
		reorder: (from, to) => {
			if (!canReorder()) return;
			const store = useRtcFreeGenStore.getState(), draft = store.draftOf(segId);
			const patch = reorderFreeRefs(draft.refs, draft.prompt, from, to, idOf);
			if (patch) store.patch(segId, patch);
		},
	};
}
