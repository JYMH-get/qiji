import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
const h = vi.hoisted(() => ({ project: {} as any, rtc: {} as any, queue: vi.fn() }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.project }, resolveEpisodeKey: (id: string) => id }));
vi.mock("@/store/rtcStore", () => ({ useRtcStore: { getState: () => h.rtc } }));
vi.mock("./rtcQueueStore", () => ({ useRtcQueueStore: { getState: () => ({ setInfo: h.queue }) } }));
import { landMedia } from "./rtcGenSink";
const S = 1_000_000;
const seg = (id: string, start: number, duration: number, extra: Partial<RtcSegment> = {}): RtcSegment => ({
	id, kind: "media", media: "video", targetStartUs: start * S, targetDurationUs: duration * S, ...extra,
});
const makeDoc = (): RtcDoc => ({ id: "doc-A", name: "A", fps: 30, tracks: [{ id: "v", type: "video", segments: [
	seg("target", 2, 10, { kind: "placeholder", status: "running", taskRef: "task-A", speed: 2 }), seg("later", 12, 3),
] }], markers: [{ id: "marker", timeUs: 12 * S, color: "#fff" }] });
const target = { episodeId: "A", segId: "target" };
const args = () => ({ owner: "owner-A", target, expectedTaskRef: "task-A", media: "video" as const, uri: "fixture://result.mp4", durationSec: 15, resizeToDuration: true });
function boot() {
	const doc = makeDoc();
	h.project = { projectInstanceId: "owner-A", isProjectLoading: false, rtcEpisodeId: "A", episodes: [], rtcDocs: { A: doc },
		setRtcEpisodeDoc: vi.fn((key: string, next: RtcDoc) => { h.project.rtcDocs[key] = next; }) };
	h.rtc = { doc, ownerProjectId: "owner-A", ownerEpisodeKey: "A", past: [],
		commit: vi.fn((mutator: (d: RtcDoc) => RtcDoc) => {
			const prev = h.rtc.doc, next = mutator(prev);
			if (next === prev) return;
			h.rtc.past.push(prev); h.rtc.doc = next; h.project.rtcDocs.A = next;
		}), patchSilent: vi.fn() };
}
beforeEach(() => { vi.clearAllMocks(); boot(); });

describe("RTC generated-video landing and timing commit", () => {
	it("lands a new result and ripple in one commit, restores 1x, and ignores a repeated receipt", () => {
		const original = h.rtc.doc;
		expect(landMedia("target", args())).toBe(true);
		expect(h.rtc.commit).toHaveBeenCalledOnce(); expect(h.rtc.past).toEqual([original]);
		expect(h.rtc.doc.tracks[0].segments[0]).toMatchObject({ kind: "media", targetStartUs: 2 * S, targetDurationUs: 15 * S,
			sourceStartUs: 0, sourceDurationUs: 15 * S, resultTaskRef: "task-A" });
		expect(h.rtc.doc.tracks[0].segments[0].speed).toBeUndefined();
		expect(h.rtc.doc.tracks[0].segments[1].targetStartUs).toBe(17 * S); expect(h.rtc.doc.markers[0].timeUs).toBe(17 * S);
		const landed = h.rtc.doc; expect(landMedia("target", args())).toBe(false); expect(h.rtc.doc).toBe(landed); expect(h.rtc.commit).toHaveBeenCalledOnce();
		// 一条撤销快照包含原占位、原后续位置与原标记，无分步中间态。
		expect(h.rtc.past[0].tracks[0].segments[0].kind).toBe("placeholder");
		expect(h.rtc.past[0].tracks[0].segments[1].targetStartUs).toBe(12 * S); expect(h.rtc.past[0].markers[0].timeUs).toBe(12 * S);
	});
	it("shortened output retains the following positions and gap", () => {
		expect(landMedia("target", { ...args(), durationSec: 6 })).toBe(true);
		expect(h.rtc.doc.tracks[0].segments[0].targetDurationUs).toBe(6 * S);
		expect(h.rtc.doc.tracks[0].segments[1].targetStartUs).toBe(12 * S); expect(h.rtc.doc.markers[0].timeUs).toBe(12 * S);
	});
	it("lands into the exact inactive episode and child without shifting the parent or active document", () => {
		const parent = makeDoc(); parent.subDocs = { child: { id: "child", name: "child", tracks: makeDoc().tracks } };
		h.project.rtcDocs.A = parent;
		const active = makeDoc(); active.id = "doc-B"; h.rtc.doc = active; h.rtc.ownerEpisodeKey = "B"; h.project.rtcDocs.B = active;
		expect(landMedia("target", { ...args(), target: { ...target, subDocId: "child" } })).toBe(true);
		expect(h.rtc.doc).toBe(active); expect(h.rtc.commit).not.toHaveBeenCalled(); expect(h.project.setRtcEpisodeDoc).toHaveBeenCalledOnce();
		const next = h.project.rtcDocs.A;
		expect(next.tracks).toBe(parent.tracks); expect(next.markers).toBe(parent.markers);
		expect(next.subDocs.child.tracks[0].segments[0].targetDurationUs).toBe(15 * S);
		expect(next.subDocs.child.tracks[0].segments[1].targetStartUs).toBe(17 * S);
	});
	it.each(["owner", "task", "cancelled", "deleted"])("cannot move anything for a stale %s delivery", stale => {
		const input = args(); if (stale === "owner") input.owner = "other"; if (stale === "task") input.expectedTaskRef = "other";
		if (stale === "deleted") h.rtc.doc.tracks[0].segments = h.rtc.doc.tracks[0].segments.slice(1);
		const before = h.rtc.doc;
		expect(landMedia("target", { ...input, ...(stale === "cancelled" ? { shouldContinue: () => false } : {}) })).toBe(false);
		expect(h.rtc.doc).toBe(before); expect(h.rtc.commit).not.toHaveBeenCalled();
	});
	it("preserves media delivery and emits one warning when a locked later track blocks timing", () => {
		h.rtc.doc.tracks.push({ id: "audio", type: "audio", locked: true, segments: [seg("voice", 12, 2)] });
		const warn = vi.fn(); expect(landMedia("target", { ...args(), onResizeWarning: warn })).toBe(true);
		expect(warn).toHaveBeenCalledOnce(); expect(warn.mock.calls[0][0]).toContain("锁定");
		expect(h.rtc.doc.tracks[0].segments[0]).toMatchObject({ kind: "media", uri: "fixture://result.mp4", targetDurationUs: 10 * S, sourceDurationUs: 15 * S });
		expect(h.rtc.doc.tracks[0].segments[1].targetStartUs).toBe(12 * S); expect(h.rtc.doc.tracks[1].segments[0].targetStartUs).toBe(12 * S);
		expect(landMedia("target", { ...args(), onResizeWarning: warn })).toBe(false); expect(warn).toHaveBeenCalledOnce();
	});
	it.each(["explicit-source", "no-resize", "image", "unknown"])("keeps established target windows for %s", mode => {
		const input = { ...args(), ...(mode === "explicit-source" ? { sourceWindow: { sourceStartUs: 3 * S, sourceDurationUs: 20 * S } } : {}),
			...(mode === "no-resize" ? { resizeToDuration: false } : {}), ...(mode === "image" ? { media: "image" as const } : {}),
			...(mode === "unknown" ? { durationSec: 0 } : {}) };
		expect(landMedia("target", input)).toBe(true);
		expect(h.rtc.doc.tracks[0].segments[0].targetDurationUs).toBe(10 * S); expect(h.rtc.doc.tracks[0].segments[0].speed).toBe(2);
		expect(h.rtc.doc.tracks[0].segments[1].targetStartUs).toBe(12 * S);
		if (mode === "explicit-source") expect(h.rtc.doc.tracks[0].segments[0]).toMatchObject({ sourceStartUs: 3 * S, sourceDurationUs: 20 * S });
	});
});
