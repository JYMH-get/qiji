import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { scriptLaneItems } from "./rtcScriptLane";
import { closeTimelineGap, resizeGeneratedVideo, timelineGapAt } from "./rtcGenerationResize";

const S = 1_000_000;
const seg = (id: string, start: number, duration: number, extra: Partial<RtcSegment> = {}): RtcSegment => ({
	id, kind: "media", media: "video", targetStartUs: start * S, targetDurationUs: duration * S, ...extra,
});
const target = (duration = 10, extra: Partial<RtcSegment> = {}) => seg("target", 2, duration, { kind: "placeholder", ...extra });
const track = (id: string, segments: RtcSegment[], extra: Partial<RtcTrack> = {}): RtcTrack => ({ id, type: "video", segments, ...extra });
const doc = (tracks: RtcTrack[], extra: Partial<RtcDoc> = {}): RtcDoc => ({ id: "doc", name: "Fixture", fps: 30, tracks, ...extra });
const byId = (d: RtcDoc, id: string) => d.tracks.flatMap(t => t.segments).find(s => s.id === id)!;

describe("generated video duration", () => {
	it("grows all later tracks and markers together, retaining gaps, source windows and relative keyframes", () => {
		const keyframes = { opacity: [{ t: S, v: 0.5 }] };
		const before = doc([
			track("main", [seg("earlier", 0, 2), target(), seg("later", 14, 3, { sourceStartUs: S, sourceDurationUs: 3 * S, keyframes })]),
			track("audio", [seg("bed", 0, 30), seg("voice", 32, 4)], { type: "audio" }),
			track("text", [seg("caption", 12, 2, { text: { content: "text" } })], { type: "text" }),
		], { markers: [{ id: "before", timeUs: S, color: "#fff" }, { id: "edge", timeUs: 12 * S, color: "#fff" }] });
		const { doc: next, reason } = resizeGeneratedVideo(before, "target", 15 * S);
		expect(reason).toBeUndefined(); expect(byId(next, "target").targetDurationUs).toBe(15 * S);
		expect(byId(next, "later")).toMatchObject({ targetStartUs: 19 * S, sourceStartUs: S, sourceDurationUs: 3 * S, keyframes });
		expect(byId(next, "voice").targetStartUs).toBe(37 * S);
		expect(byId(next, "caption").targetStartUs).toBe(17 * S);
		expect(byId(next, "bed")).toBe(byId(before, "bed")); expect(byId(next, "earlier")).toBe(byId(before, "earlier"));
		expect(next.markers?.map(m => m.timeUs)).toEqual([S, 17 * S]);
		expect(byId(before, "target").targetDurationUs).toBe(10 * S);
		expect(resizeGeneratedVideo(next, "target", 15 * S).doc).toBe(next);
	});
	it("shortens only the target, leaving subsequent media, captions and markers at their positions", () => {
		const before = doc([track("main", [target(15, { shotRef: { episodeId: "ep", shotId: "shot" } }), seg("later", 17, 3)]),
			track("audio", [seg("voice", 17, 3)], { type: "audio" })], { markers: [{ id: "edge", timeUs: 17 * S, color: "#fff" }] });
		const next = resizeGeneratedVideo(before, "target", 10 * S).doc;
		expect(byId(next, "target").targetDurationUs).toBe(10 * S);
		expect(byId(next, "later")).toBe(byId(before, "later")); expect(next.tracks[1]).toBe(before.tracks[1]); expect(next.markers).toBe(before.markers);
		expect(scriptLaneItems(next, { id: "ep", shots: [{ id: "shot", scriptSegment: "原文" }] })).toEqual([
			{ key: "target", startUs: 2 * S, durUs: 10 * S, text: "原文" },
		]);
	});
	it("moves an explicit group's member before the boundary together with its later member", () => {
		const before = doc([track("main", [target(), seg("later", 12, 2, { groupId: "g" })]),
			track("audio", [seg("lead-in", 10, 1, { groupId: "g" })], { type: "audio" })]);
		const next = resizeGeneratedVideo(before, "target", 15 * S).doc;
		expect(byId(next, "lead-in").targetStartUs).toBe(15 * S); expect(byId(next, "later").targetStartUs).toBe(17 * S);
	});
	it.each(["target", "later", "group-member"])("atomically blocks timing when %s is locked", locked => {
		const before = doc([track("main", [target(), seg("later", 12, 2)], { locked: locked === "target" }),
			track("audio", [seg("voice", 13, 2, { groupId: "g" })], { type: "audio", locked: locked === "later" }),
			track("text", [seg("lead-in", 10, 1, { groupId: "g" })], { type: "text", locked: locked === "group-member" })]);
		const result = resizeGeneratedVideo(before, "target", 15 * S);
		expect(result.doc).toBe(before); expect(result.reason).toContain("锁定");
	});
	it("blocks a group tied to the target or a newly overlapping lead-in instead of partially moving tracks", () => {
		const tied = doc([track("main", [target(10, { groupId: "g" }), seg("later", 12, 2, { groupId: "g" })])]);
		expect(resizeGeneratedVideo(tied, "target", 15 * S)).toMatchObject({ doc: tied, reason: expect.any(String) });
		const overlap = doc([track("main", [target(), seg("later", 12, 2, { groupId: "g" })]),
			track("other", [seg("lead", 6, 2, { groupId: "g" }), seg("fixed", 9, 3)])]);
		expect(resizeGeneratedVideo(overlap, "target", 15 * S)).toMatchObject({ doc: overlap, reason: expect.stringContaining("覆盖") });
	});
	it("invalid durations, same duration, absent and already delivered targets do nothing", () => {
		const before = doc([track("main", [target(), seg("done", 12, 4)])]);
		for (const duration of [0, -1, NaN, Infinity, 10 * S]) expect(resizeGeneratedVideo(before, "target", duration).doc).toBe(before);
		expect(resizeGeneratedVideo(before, "missing", 15 * S).doc).toBe(before);
		expect(resizeGeneratedVideo(before, "done", 15 * S).doc).toBe(before);
	});
});

describe("timeline gap closure", () => {
	it("detects only internal gaps after merging adjacent and overlapping occupied spans", () => {
		const d = doc([track("main", [seg("contained", 2, 1), seg("a", 1, 5), seg("adjacent", 6, 2), seg("b", 12, 3)])]);
		for (const at of [0, 1, 3, 6, 7.99, 12, 16, NaN]) expect(timelineGapAt(d, "main", at * S)).toBeNull();
		expect(timelineGapAt(d, "main", 8 * S)).toEqual({ startUs: 8 * S, endUs: 12 * S });
		expect(timelineGapAt(d, "main", 10 * S)).toEqual({ startUs: 8 * S, endUs: 12 * S });
	});
	it("closes exactly once with all later audio/text/group members and markers, preserving sources", () => {
		const d = doc([track("main", [seg("a", 0, 5), seg("b", 8, 3, { groupId: "g" })]),
			track("audio", [seg("lead", 7, 2, { groupId: "g", sourceStartUs: 2 * S, sourceDurationUs: 2 * S })], { type: "audio" }),
			track("text", [seg("caption", 9, 1)], { type: "text" })],
		{ markers: [{ id: "inside", timeUs: 6 * S, color: "#fff" }, { id: "end", timeUs: 8 * S, color: "#fff" }] });
		const result = closeTimelineGap(d, "main", 5 * S, 8 * S);
		expect(result.reason).toBeUndefined(); expect(byId(result.doc, "b").targetStartUs).toBe(5 * S);
		expect(byId(result.doc, "lead")).toMatchObject({ targetStartUs: 4 * S, sourceStartUs: 2 * S, sourceDurationUs: 2 * S });
		expect(byId(result.doc, "caption").targetStartUs).toBe(6 * S); expect(result.doc.markers?.map(m => m.timeUs)).toEqual([5 * S, 5 * S]);
		expect(closeTimelineGap(result.doc, "main", 5 * S, 8 * S).doc).toBe(result.doc);
	});
	it.each(["overlap", "locked", "negative"])("returns an atomic blocking reason for %s", mode => {
		const d = doc([track("main", [seg("a", 0, 5), seg("b", 8, 3, { groupId: "g" })]),
			track("other", mode === "overlap" ? [seg("fixed", 3, 4), seg("later", 8, 3)] :
				[seg("linked", mode === "negative" ? 1 : 8, 1, { groupId: "g" })], { locked: mode === "locked" })]);
		const result = closeTimelineGap(d, "main", 5 * S, 8 * S);
		expect(result.doc).toBe(d); expect(result.reason).toBeTruthy();
	});
	it("rejects stale or leading/trailing spans and a locked host", () => {
		const d = doc([track("main", [seg("a", 2, 3), seg("b", 8, 3)])]);
		for (const [a, b] of [[0, 2], [5, 9], [11, 20], [8, 5]]) expect(closeTimelineGap(d, "main", a * S, b * S).doc).toBe(d);
		const locked = { ...d, tracks: [{ ...d.tracks[0], locked: true }] };
		expect(closeTimelineGap(locked, "main", 5 * S, 8 * S).reason).toContain("锁定");
	});
});
