import { describe, it, expect } from "vitest";
import { modelMethods, clampMethod, videoReqOptions, clampToOptions, clampDurationTo } from "@/lib/videoMethods";
import { VIDEO_ASPECTS, VIDEO_DURATIONS, VIDEO_RESOLUTIONS } from "@/lib/genParams";
import type { CatalogModel } from "@/contract";

const model = (over: Partial<CatalogModel>): CatalogModel =>
	({ id: "m", label: "m", capability: "video", params: [], cost: 30, ...over } as CatalogModel);

describe("videoMethods 方法层（第131轮）", () => {
	it("modelMethods：未声明/空/本地 CLI（无 catalog）→ 仅全能参考；声明取声明；未知值剔除", () => {
		expect(modelMethods(undefined)).toEqual(["omni"]);
		expect(modelMethods(model({}))).toEqual(["omni"]);
		expect(modelMethods(model({ methods: ["omni", "frames"] }))).toEqual(["omni", "frames"]);
		expect(modelMethods(model({ methods: ["frames", "bogus"] }))).toEqual(["frames"]);
	});

	it("clampMethod：残留值收敛到支持集（不在集合→第一项）", () => {
		expect(clampMethod("frames", ["omni", "frames"])).toBe("frames");
		expect(clampMethod("frames", ["omni"])).toBe("omni");
		expect(clampMethod(undefined, ["omni", "frames"])).toBe("omni");
	});
});

describe("videoMethods 要求层（catalog params 服务端控档）", () => {
	it("videoReqOptions：未声明参数回退内置常量", () => {
		const r = videoReqOptions(undefined);
		expect(r.resolutions).toEqual(VIDEO_RESOLUTIONS);
		expect(r.aspects).toEqual(VIDEO_ASPECTS);
		expect(r.durations).toEqual(VIDEO_DURATIONS);
	});

	it("videoReqOptions：enum 时长（hn 5/10/15）与 number 时长（4-15）均按声明", () => {
		const hn = videoReqOptions(model({ params: [
			{ key: "resolution", label: "分辨率", type: "enum", options: ["720p"] },
			{ key: "duration", label: "时长", type: "enum", options: ["5", "10", "15"] },
			{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "adaptive"] },
		] }));
		expect(hn.durations).toEqual([5, 10, 15]);
		expect(hn.resolutions).toEqual(["720p"]);
		expect(hn.aspects).toEqual(["16:9", "adaptive"]);
		const num = videoReqOptions(model({ params: [{ key: "duration", label: "时长", type: "number", min: 4, max: 15 }] }));
		expect(num.durations).toEqual(VIDEO_DURATIONS);
	});

	it("clampToOptions / clampDurationTo：不在档→回退；时长就近取档（8→10）", () => {
		expect(clampToOptions("1080p", ["720p", "1080p"])).toBe("1080p");
		expect(clampToOptions("480p", ["720p", "1080p"], "720p")).toBe("720p");
		expect(clampDurationTo(8, [5, 10, 15])).toBe(10);
		expect(clampDurationTo(15, [5, 10, 15])).toBe(15);
		expect(clampDurationTo(7, [])).toBe(7);
	});
});
