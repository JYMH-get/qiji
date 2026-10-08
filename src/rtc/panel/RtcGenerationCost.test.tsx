import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaSettings, StoryboardShot } from "@/services/projectFile";
import type { RtcSegment } from "@/types/rtc";

const h = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>, pending: [] as any[], draft: {} as any,
	requests: [] as any[], batches: [] as any[][],
}));
vi.mock("@/components/GenerationCost", () => ({
	GenerationCost: (props: unknown) => { h.requests.push(props); return null; },
	useGenerationCosts: (requests: any[]) => { h.batches.push(requests); return 42; },
}));
vi.mock("@/components/ModelPicker", () => ({ useEffectiveModelKey: (cap: string) => `default-${cap}` }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: (selector: any) => selector({ mediaSettings: h.settings, pendingGens: h.pending }) }));
vi.mock("@/store/catalogStore", () => ({ useCatalogStore: (selector: any) => selector({ catalog: { models: [], templates: [] } }) }));
vi.mock("./rtcFreeGenStore", () => ({ useRtcFreeGenStore: (selector: any) => selector({ drafts: { segment: h.draft } }) }));
vi.mock("@/lib/modelOptions", () => ({
	videoReqOptionsForKey: () => ({ durations: [5, 10, 15], resolutions: ["720p"], aspects: ["16:9"] }),
	modelMethodsForKey: () => ["omni"], imageResolutionOptionsForKey: () => [{ v: "2k", label: "2K" }],
}));

import { RtcEpisodeGenerationCost, RtcFreeGenerationCost, RtcShotGenerationCost, rtcShotVideoCostParams } from "./RtcGenerationCost";
const shot = (id = "shot"): StoryboardShot => ({ id, title: id, durationSec: 5, overrides: { videoModelKey: "shot-video", duration: 15, resolution: "1080p", aspect: "9:16", method: "frames" }, materials: [{ id: "ref", kind: "local", name: "参考视频", uri: "ref.mp4", media: "video" }] } as StoryboardShot);
const segment = { id: "segment", kind: "placeholder", genKind: "video", targetDurationUs: 5_100_000, generationDuration: "auto" } as RtcSegment;
beforeEach(() => {
	h.settings = { maxDuration: 10, resolution: "480p", aspect: "16:9", videoMethod: "omni", imageAspect: "4:3", imageResolution: "4k", imageQuality: "high", genWithAsset: true };
	h.pending = []; h.draft = {}; h.requests = []; h.batches = [];
});

describe("RTC generation cost request snapshots", () => {
	it("prices the actual Auto duration while preserving per-shot overrides", () => {
		expect(rtcShotVideoCostParams(shot(), h.settings as MediaSettings, "shot-video", segment)).toEqual({ duration: 10, resolution: "1080p", aspect_ratio: "9:16", method: "frames" });
		expect(rtcShotVideoCostParams(shot(), h.settings as MediaSettings, "shot-video").duration).toBe(15);
	});
	it("respects the material toggle and only includes video references for video billing", () => {
		renderToStaticMarkup(<RtcShotGenerationCost shot={shot()} field="video" segment={segment} />);
		expect(h.requests[h.requests.length - 1]).toMatchObject({ modelKey: "shot-video", refVideoUris: ["ref.mp4"], params: { duration: 10 } });
		h.settings.genWithAsset = false;
		renderToStaticMarkup(<RtcShotGenerationCost shot={shot()} field="video" segment={segment} />);
		expect(h.requests[h.requests.length - 1].refVideoUris).toEqual([]);
		renderToStaticMarkup(<RtcShotGenerationCost shot={shot()} field="storyboard" />);
		expect(h.requests[h.requests.length - 1]).toMatchObject({ modelKey: "default-image", params: { aspect_ratio: "4:3", resolution: "4k", quality: "high" }, refVideoUris: [] });
	});
	it("prices each batch shot independently and excludes only this episode's running requests", () => {
		h.pending = [{ status: "running", shot: { episodeId: "episode", shotId: "a", field: "video" } }, { status: "running", shot: { episodeId: "other", shotId: "b", field: "video" } }];
		const a = shot("a"), b = { ...shot("b"), overrides: { videoModelKey: "second-video", duration: 6 } }, c = { ...shot("c"), overrides: undefined };
		renderToStaticMarkup(<RtcEpisodeGenerationCost episodeId="episode" shots={[a, b, c]} field="video" />);
		expect(h.batches[h.batches.length - 1]).toMatchObject([{ modelKey: "second-video", params: { duration: 6 } }, { modelKey: "default-video", params: { duration: 5 } }]);
	});
	it("uses free placeholder drafts and selects the correct image default model", () => {
		h.draft = { refs: [{ media: "video", uri: "free.mp4" }], modelKey: "free-video" };
		renderToStaticMarkup(<RtcFreeGenerationCost segment={segment} />);
		expect(h.requests[h.requests.length - 1]).toMatchObject({ modelKey: "free-video", params: { duration: 10, resolution: "480p" }, refVideoUris: ["free.mp4"] });
		h.draft = {};
		renderToStaticMarkup(<RtcFreeGenerationCost segment={{ ...segment, genKind: "image" }} />);
		expect(h.requests[h.requests.length - 1]).toMatchObject({ modelKey: "default-image", params: { resolution: "4k", aspect_ratio: "4:3" } });
	});
});
