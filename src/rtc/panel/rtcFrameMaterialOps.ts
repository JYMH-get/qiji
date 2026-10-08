import { useProjectStore } from "@/store/projectStore";
import type { ShotMaterial, StoryboardShot } from "@/services/projectFile";
import { genId } from "@/lib/id";
import { LEGEND_START, materialTags, splitLegendPrompt } from "@/lib/shotMaterials";
import { resyncShotLegend } from "@/lib/shotMaterialOps";
import { liveSegment, resolveRtcTarget } from "./rtcGenSink";
import { useRtcFreeGenStore } from "./rtcFreeGenStore";
import { replaceRtcFrameReference, type RtcFrameRole } from "./rtcFrameMaterials";

export interface RtcFrameAsset { uri: string; assetId?: string; name?: string }

/** Remove only the replaced slot's old legend description; retain all body text and other descriptions. */
function withoutSlotLegend(prompt: string, tag: string): string {
	const parts = splitLegendPrompt(prompt);
	const entries = parts.entries.filter(entry => entry.key !== `desc:${tag}`);
	const legend = entries.length ? `${LEGEND_START}${entries.map(entry => entry.text).join("；")}；` : "";
	return legend && parts.body ? `${legend}\n\n${parts.body}` : legend || parts.body;
}

export function setRtcShotFrameMaterial(episodeId: string, shotId: string, role: RtcFrameRole, frame: RtcFrameAsset, expectedOwner: string): boolean {
	const state = useProjectStore.getState();
	if (state.projectInstanceId !== expectedOwner || state.isProjectLoading || !frame.uri) return false;
	const shot = state.episodes.find(ep => ep.id === episodeId)?.shots.find(item => item.id === shotId);
	if (!shot) return false;
	const previous = shot.materials.find(material => material.rtcFrameRole === role && (!material.media || material.media === "image"));
	const material: ShotMaterial = { id: previous?.id ?? genId("mat"), kind: "local", media: "image", uri: frame.uri,
		assetId: frame.assetId, name: frame.name || (role === "first" ? "首帧" : "尾帧"), usage: "reference", rtcFrameRole: role };
	const patch: Partial<StoryboardShot> = { materials: replaceRtcFrameReference(shot.materials, role, material) };
	if (previous) {
		const tag = materialTags(shot.materials)[previous.id];
		for (const field of ["unifiedPrompt", "videoPrompt", "storyboardPrompt"] as const) {
			if (shot[field] !== undefined) patch[field] = withoutSlotLegend(shot[field]!, tag);
		}
	}
	state.updateShot(episodeId, shotId, patch);
	resyncShotLegend(episodeId, shotId);
	return true;
}

export function setRtcFreeFrameMaterial(segId: string, role: RtcFrameRole, frame: RtcFrameAsset, expectedOwner: string): boolean {
	const state = useProjectStore.getState();
	if (state.projectInstanceId !== expectedOwner || state.isProjectLoading || !frame.uri) return false;
	const target = resolveRtcTarget(segId), seg = target && liveSegment(segId, target);
	if (!seg || seg.kind !== "placeholder") return false;
	const store = useRtcFreeGenStore.getState();
	store.patch(segId, { refs: replaceRtcFrameReference(store.draftOf(segId).refs, role, { ...frame, media: "image", rtcFrameRole: role }) });
	return true;
}
