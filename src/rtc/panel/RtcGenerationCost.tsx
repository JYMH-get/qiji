import { GenerationCost, useGenerationCosts } from "@/components/GenerationCost";
import { useEffectiveModelKey } from "@/components/ModelPicker";
import { buildImageParams, imageResolutionOptions } from "@/lib/genParams";
import { imageResolutionOptionsForKey, modelMethodsForKey, videoReqOptionsForKey } from "@/lib/modelOptions";
import { mediaOf } from "@/lib/shotMaterials";
import { assetImageAspectFrom } from "@/lib/templateAspect";
import type { MediaSettings, StoryboardShot } from "@/services/projectFile";
import { useCatalogStore } from "@/store/catalogStore";
import { useProjectStore } from "@/store/projectStore";
import type { RtcSegment } from "@/types/rtc";
import { resolveRtcGenerationDuration } from "./rtcGenerationDuration";
import { buildFreeImageParams, buildFreeVideoParams } from "./rtcGenCore";
import { useRtcFreeGenStore } from "./rtcFreeGenStore";

/** Read the same request fields as shotGenActions, including segment Auto duration. */
export function rtcShotVideoCostParams(shot: StoryboardShot, ms: MediaSettings, modelKey: string, segment?: RtcSegment): Record<string, unknown> {
	const ov = shot.overrides ?? {}, req = videoReqOptionsForKey(modelKey);
	const method = ov.method ?? ms.videoMethod ?? modelMethodsForKey(modelKey)[0];
	return {
		duration: resolveRtcGenerationDuration(segment?.generationDuration, segment?.targetDurationUs, req.durations, ov.duration ?? shot.durationSec ?? ms.maxDuration ?? req.durations[0] ?? 15),
		resolution: ov.resolution ?? ms.resolution ?? req.resolutions[0] ?? "720p",
		aspect_ratio: ov.aspect ?? ms.aspect ?? req.aspects[0] ?? "16:9",
		...(method !== undefined ? { method } : {}),
	};
}

export function RtcShotGenerationCost({ shot, field, segment }: { shot: StoryboardShot; field: "storyboard" | "video"; segment?: RtcSegment }) {
	const ms = useProjectStore(s => s.mediaSettings);
	const defaultModel = useEffectiveModelKey(field === "storyboard" ? "image" : "video");
	useCatalogStore(s => s.catalog);
	const modelKey = field === "video" ? shot.overrides?.videoModelKey || defaultModel : defaultModel;
	const params = field === "video" ? rtcShotVideoCostParams(shot, ms, modelKey, segment)
		: buildImageParams({ aspect: ms.imageAspect ?? "16:9", ...(ms.imageResolution !== undefined ? { resolution: ms.imageResolution } : {}), quality: ms.imageQuality ?? "high" }, imageResolutionOptionsForKey(modelKey));
	const refVideoUris = field === "video" && (ms.genWithAsset ?? true)
		? shot.materials.filter(material => mediaOf(material) === "video").map(material => material.uri) : [];
	return <GenerationCost modelKey={modelKey} params={params} refVideoUris={refVideoUris} />;
}

export function RtcFreeGenerationCost({ segment }: { segment: RtcSegment }) {
	const kind = segment.genKind ?? segment.media ?? "video";
	const defaultModel = useEffectiveModelKey(kind === "image" ? "image" : "video");
	const ms = useProjectStore(s => s.mediaSettings);
	const draft = useRtcFreeGenStore(s => s.drafts[segment.id]);
	useCatalogStore(s => s.catalog);
	const modelKey = draft?.modelKey || defaultModel;
	const req = videoReqOptionsForKey(modelKey);
	const params = kind === "video" ? {
		...buildFreeVideoParams(segment.targetDurationUs, ms, req),
		duration: resolveRtcGenerationDuration(segment.generationDuration ?? "auto", segment.targetDurationUs, req.durations, 1),
		...(ms.videoMethod !== undefined ? { method: ms.videoMethod } : {}),
	} : buildFreeImageParams(ms, imageResolutionOptionsForKey(modelKey));
	const refVideoUris = kind === "video" ? (draft?.refs ?? []).filter(ref => ref.media === "video").map(ref => ref.uri) : [];
	return <GenerationCost modelKey={modelKey} params={params} refVideoUris={refVideoUris} />;
}

export function RtcAssetGenerationCost() {
	const modelKey = useEffectiveModelKey("image");
	const catalog = useCatalogStore(s => s.catalog);
	const ms = useProjectStore(s => s.mediaSettings);
	const aspect = assetImageAspectFrom(catalog?.templates, ms.assetExtractTplId, ms.imageAspect);
	return <GenerationCost modelKey={modelKey} params={buildImageParams({ aspect }, imageResolutionOptions(catalog?.models.find(model => model.id === modelKey)))} />;
}

export function RtcTextGenerationCost() {
	const modelKey = useEffectiveModelKey("text");
	return <GenerationCost modelKey={modelKey} />;
}

export function RtcRegenerationCost({ segment }: { segment: RtcSegment }) {
	const shot = useProjectStore(s => s.episodes.find(ep => ep.id === segment.shotRef?.episodeId)?.shots.find(item => item.id === segment.shotRef?.shotId));
	return shot ? <RtcShotGenerationCost shot={shot} field="video" segment={segment} /> : <GenerationCost cost={null} />;
}

export function RtcEpisodeGenerationCost({ episodeId, shots, field }: { episodeId: string; shots: readonly StoryboardShot[]; field: "storyboard" | "video" }) {
	const ms = useProjectStore(s => s.mediaSettings);
	const defaultModel = useEffectiveModelKey(field === "storyboard" ? "image" : "video");
	const pending = useProjectStore(s => s.pendingGens);
	useCatalogStore(s => s.catalog);
	const cost = useGenerationCosts(shots.filter(shot => !pending.some(job => job.status === "running" && job.shot?.episodeId === episodeId && job.shot.shotId === shot.id && job.shot.field === field)).map(shot => {
		const modelKey = field === "video" ? shot.overrides?.videoModelKey || defaultModel : defaultModel;
		return {
			modelKey,
			params: field === "video" ? rtcShotVideoCostParams(shot, ms, modelKey)
				: buildImageParams({ aspect: ms.imageAspect ?? "16:9", ...(ms.imageResolution !== undefined ? { resolution: ms.imageResolution } : {}), quality: ms.imageQuality ?? "high" }, imageResolutionOptionsForKey(modelKey)),
			refVideoUris: field === "video" && (ms.genWithAsset ?? true) ? shot.materials.filter(material => mediaOf(material) === "video").map(material => material.uri) : [],
		};
	}));
	return <GenerationCost cost={cost} />;
}
