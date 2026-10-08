import { create } from "zustand";
import { useProjectStore } from "@/store/projectStore";
import type { MediaSettings, StoryboardShot, RtcGenerationTarget } from "@/services/projectFile";
import { liveSegment, resolveRtcTarget } from "./rtcGenSink";

export type ShotSubmissionField = "storyboard" | "video" | "infer";
export type RtcSubmissionTarget = RtcGenerationTarget;
const preparationKey = (owner: string, episodeId: string, shotId: string, field: ShotSubmissionField) =>
	JSON.stringify([owner, episodeId, shotId, field]);
const usePreparationStore = create<{ claims: Record<string, symbol> }>(() => ({ claims: {} }));

/** Preparation is observable immediately, before upload/import yields or a paid task exists. */
export function useShotPreparing(episodeId: string, shotId: string, field: ShotSubmissionField): boolean {
	const owner = useProjectStore((s) => s.projectInstanceId);
	return usePreparationStore((s) => !!s.claims[preparationKey(owner, episodeId, shotId, field)]);
}

/** Locate by the document's owner, including inactive episodes; shotRef may belong to another episode. */
export function locateRtcTarget(segId: string): RtcSubmissionTarget | undefined {
	return resolveRtcTarget(segId) ?? undefined;
}

export function currentRtcTarget(target: RtcSubmissionTarget) {
	return liveSegment(target.segId, target) ?? undefined;
}

export interface ShotPreparation {
	owner: string;
	episodeId: string;
	shotId: string;
	field: ShotSubmissionField;
	shot: StoryboardShot;
	mediaSettings: MediaSettings;
	rtcTarget?: RtcSubmissionTarget;
	bindTarget: (segId: string) => boolean;
	alive: () => boolean;
	release: () => void;
}

/** Claim synchronously; callers may create a new version placeholder only after this succeeds. */
export function claimShotPreparation(episodeId: string, shotId: string, field: ShotSubmissionField): ShotPreparation | null {
	const ps = useProjectStore.getState();
	const shot = ps.episodes.find(e => e.id === episodeId)?.shots.find(s => s.id === shotId);
	if (!shot || ps.isProjectLoading) return null;
	if (field === "infer"
		? ps.inferTasks.some(t => t.episodeId === episodeId && t.shotId === shotId && t.mode === "single" && t.status === "running")
		: ps.pendingGens.some(p => p.status === "running" && p.shot?.episodeId === episodeId && p.shot.shotId === shotId && p.shot.field === field)) return null;
	const owner = ps.projectInstanceId, key = preparationKey(owner, episodeId, shotId, field);
	if (usePreparationStore.getState().claims[key]) return null;
	const token = Symbol(key);
	usePreparationStore.setState(s => ({ claims: { ...s.claims, [key]: token } }));
	const claim: ShotPreparation = {
		owner, episodeId, shotId, field,
		shot: structuredClone(shot), mediaSettings: structuredClone(ps.mediaSettings),
		bindTarget(segId) {
			if (!claim.alive()) return false;
			claim.rtcTarget = locateRtcTarget(segId);
			return !!claim.rtcTarget && claim.alive();
		},
		alive() {
			const state = useProjectStore.getState();
			if (state.projectInstanceId !== owner || state.isProjectLoading || usePreparationStore.getState().claims[key] !== token) return false;
			if (!state.episodes.find(e => e.id === episodeId)?.shots.some(s => s.id === shotId)) return false;
			if (!claim.rtcTarget) return true;
			const seg = currentRtcTarget(claim.rtcTarget);
			return !!seg && seg.kind === "placeholder" && seg.shotRef?.episodeId === episodeId && seg.shotRef.shotId === shotId;
		},
		release() {
			usePreparationStore.setState(s => {
				if (s.claims[key] !== token) return s;
				const claims = { ...s.claims }; delete claims[key]; return { claims };
			});
		},
	};
	return claim;
}

/** A saved explicit choice remains visible even when a refreshed catalog no longer lists it. */
export function withCurrentOption<T extends string | number>(options: readonly T[], value: T): T[] {
	return options.includes(value) ? [...options] : [value, ...options];
}
