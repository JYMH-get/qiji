import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { JY_PREVIEW_TRANSITIONS } from "@/lib/jyTransitions";
import { nextVideoBoundaryUs, nextVideoLayers, videoBoundaryTimes } from "./rtcVideoLookahead";

const SEC = 1_000_000;
const segment = (id: string, start: number, duration: number, extra: Partial<RtcSegment> = {}): RtcSegment => ({
	id, kind: "media", media: "video", uri: `video://${id}`, targetStartUs: start, targetDurationUs: duration,
	sourceStartUs: 0, sourceDurationUs: duration, ...extra,
});
const track = (id: string, segments: RtcSegment[], type: RtcTrack["type"] = "video"): RtcTrack => ({ id, type, segments });
const doc = (...tracks: RtcTrack[]): RtcDoc => ({ id: "doc", name: "fixture", fps: 30, tracks });
const transition = (kind: string, durationUs = SEC) => {
	const effect = JY_PREVIEW_TRANSITIONS.find(t => t.previewKind === kind)!;
	return { effectId: effect.effectId, durationUs } as NonNullable<RtcSegment["transitionAfter"]>;
};

describe("真实视频边界与预热入点", () => {
	it("边界去重排序，跳过音轨；二分查找严格晚于当前时刻", () => {
		const d = doc(track("v", [segment("b", 2 * SEC, SEC), segment("a", 0, 2 * SEC)]), track("audio", [segment("s", 123, 456)], "audio"));
		const times = videoBoundaryTimes(d);
		expect(times).toEqual([0, 2 * SEC, 3 * SEC]);
		expect(nextVideoBoundaryUs(times, -1)).toBe(0);
		expect(nextVideoBoundaryUs(times, 2 * SEC)).toBe(3 * SEC);
		expect(nextVideoBoundaryUs(times, 3 * SEC)).toBeNull();
		expect(nextVideoBoundaryUs(times, Number.NaN)).toBeNull();
	});

	it("不同 URI 严格相邻：提前返回 B 精确源入点，不返回当前 A", () => {
		const d = doc(track("v", [segment("a", 0, 2 * SEC), segment("b", 2 * SEC, 2 * SEC, { sourceStartUs: 3 * SEC, speed: 2 })]));
		const next = nextVideoLayers(d, SEC);
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({ trackId: "v", uri: "video://b", sourceSec: 3, rate: 2 });
		expect(nextVideoLayers(d, 0, SEC)).toEqual([]);
		expect(nextVideoLayers(d, 0, 2 * SEC)).toEqual(next);
	});

	it("同 URI 连续 split 不预热，后续首次真实源跳转才入选", () => {
		const d = doc(track("v", [
			segment("a", 0, SEC, { uri: "same", speed: 2, sourceDurationUs: 2 * SEC }),
			segment("b", SEC, SEC, { uri: "same", sourceStartUs: 2 * SEC, sourceDurationUs: 2 * SEC, speed: 2 }),
			segment("c", 2 * SEC, SEC, { uri: "same", sourceStartUs: 8 * SEC }),
		]));
		expect(nextVideoLayers(d, 0, SEC)).toEqual([]);
		expect(nextVideoLayers(d, 0, 3 * SEC).map(l => [l.seg.id, l.sourceSec])).toEqual([["c", 8]]);
	});

	it("每槽只预热最近一次换源，多个轨道独立；缓存边界结果一致", () => {
		const d = doc(track("v1", [segment("a", 0, SEC), segment("b", SEC, SEC), segment("c", 2 * SEC, SEC)]),
			track("v2", [segment("d", 0, 1.2 * SEC), segment("e", 1.2 * SEC, SEC)]));
		const next = nextVideoLayers(d, 0, 3 * SEC, videoBoundaryTimes(d));
		expect(next.map(l => l.seg.id)).toEqual(["b", "e"]);
		expect(nextVideoLayers(d, 0, 3 * SEC)).toEqual(next);
	});

	it("真实空隙不造画面；同 URI 跨空隙再次入场仍预热", () => {
		const d = doc(track("v", [segment("a", 0, SEC, { uri: "same" }), segment("b", 2 * SEC, SEC, { uri: "same" })]));
		expect(nextVideoLayers(d, 0, 1.5 * SEC)).toEqual([]);
		expect(nextVideoBoundaryUs(videoBoundaryTimes(d), SEC)).toBe(2 * SEC);
		expect(nextVideoLayers(d, 1.5 * SEC)[0]).toMatchObject({ uri: "same", sourceSec: 0 });
	});

	it("图片/占位入点不预热视频；空输入与无效范围安全返回", () => {
		const d = doc(track("v", [segment("image", 0, SEC, { media: "image" }), segment("ph", SEC, SEC, { kind: "placeholder" }), segment("v", 2 * SEC, SEC)]));
		expect(nextVideoLayers(d, -1, 2 * SEC)).toEqual([]);
		expect(nextVideoLayers(d, SEC).map(l => l.seg.id)).toEqual(["v"]);
		expect(nextVideoLayers(doc(), 0)).toEqual([]);
		expect(nextVideoLayers(d, 0, 0)).toEqual([]);
		expect(nextVideoLayers(d, Number.NaN)).toEqual([]);
	});

	it("源窗口耗尽不会制造下一个入点，同源尾连续剪接不多预热", () => {
		const d = doc(track("v", [segment("a", 0, 2 * SEC, { uri: "same", sourceDurationUs: SEC }), segment("b", 2 * SEC, SEC, { uri: "same", sourceStartUs: SEC })]));
		expect(nextVideoLayers(d, 0, 2 * SEC)).toEqual([]);
	});
});

describe("转场边界", () => {
	it("叠化开始预热 B 幽灵，切点预热主层 B 与幽灵 A", () => {
		const d = doc(track("v", [segment("a", 0, 4 * SEC, { transitionAfter: transition("dissolve") }), segment("b", 4 * SEC, 4 * SEC, { sourceStartUs: SEC })]));
		expect(videoBoundaryTimes(d)).toEqual([0, 3.5 * SEC, 4 * SEC, 4.5 * SEC, 8 * SEC]);
		expect(nextVideoLayers(d, 3 * SEC).map(l => [l.trackId, l.seg.id, l.sourceSec])).toEqual([["v#tr", "b", 1], ["v", "b", 1]]);
		expect(nextVideoLayers(d, 3.6 * SEC).map(l => [l.trackId, l.seg.id, l.sourceSec])).toEqual([["v", "b", 1], ["v#tr", "a", 4]]);
	});

	it("推移只在切点前开幽灵；闪黑保留边界但不将纯色层当作视频", () => {
		const make = (kind: string) => doc(track("v", [segment("a", 0, 4 * SEC, { transitionAfter: transition(kind) }), segment("b", 4 * SEC, SEC)]));
		expect(videoBoundaryTimes(make("slideleft"))).toEqual([0, 3 * SEC, 4 * SEC, 5 * SEC]);
		expect(nextVideoLayers(make("slideleft"), 2.5 * SEC).map(l => l.trackId)).toEqual(["v#tr", "v"]);
		expect(nextVideoLayers(make("flashblack"), 3 * SEC).map(l => l.trackId)).toEqual(["v"]);
	});

	it("转场窗口裁到片段跨度；无相邻片段或不支持的转场不造边界", () => {
		const d = doc(track("v", [segment("a", 3 * SEC, 0.2 * SEC, { transitionAfter: transition("dissolve", 4 * SEC) }), segment("b", 3.2 * SEC, 0.3 * SEC)]));
		expect(videoBoundaryTimes(d)).toEqual([3 * SEC, 3.2 * SEC, 3.5 * SEC]);
		const gappy = doc(track("v", [segment("a", 0, SEC, { transitionAfter: transition("dissolve") }), segment("b", 2 * SEC, SEC)]));
		expect(videoBoundaryTimes(gappy)).toEqual([0, SEC, 2 * SEC, 3 * SEC]);
	});
});

describe("一层复合片段边界", () => {
	it("按宿主 source 偏移与倍速映射子轨入点，直接复用 videoStageAt 的层参数", () => {
		const d = doc(track("v", [segment("compound", 2 * SEC, 3 * SEC, { kind: "compound", subDocId: "sub", sourceStartUs: SEC, sourceDurationUs: 4 * SEC, speed: 2 })]));
		d.subDocs = { sub: { id: "sub", name: "sub", tracks: [track("child", [segment("a", 0, 2 * SEC), segment("b", 2 * SEC, 2 * SEC, { sourceStartUs: 7 * SEC, speed: 0.5 })]), track("sound", [segment("x", 1.3 * SEC, SEC)], "audio")] } };
		expect(videoBoundaryTimes(d)).toEqual([2 * SEC, 2.5 * SEC, 3.5 * SEC, 5 * SEC]);
		expect(nextVideoLayers(d, 2 * SEC)[0]).toMatchObject({ trackId: "compound/child", uri: "video://b", sourceSec: 7, rate: 1 });
		expect(nextVideoLayers(d, SEC)[0]).toMatchObject({ trackId: "compound/child", uri: "video://a", sourceSec: 1, rate: 2 });
	});

	it("子边界不越宿主可见/source窗口，分数微秒向上落到后一段", () => {
		const d = doc(track("v", [segment("c", 0, SEC, { kind: "compound", subDocId: "sub", sourceDurationUs: 2 * SEC, speed: 3 })]));
		d.subDocs = { sub: { id: "sub", name: "sub", tracks: [track("child", [segment("a", 0, SEC), segment("b", SEC, SEC), segment("outside", 3 * SEC, SEC)])] } };
		expect(videoBoundaryTimes(d)).toEqual([0, 333334, 666667, SEC]);
		expect(nextVideoLayers(d, 0)[0]).toMatchObject({ trackId: "c/child", seg: { id: "b" } });
		expect(nextVideoLayers(d, 0)[0].sourceSec).toBeCloseTo(0, 5);
	});
});
