import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
const h = vi.hoisted(() => ({ project: {} as any, rtc: {} as any }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.project }, resolveEpisodeKey: (id: string) => id }));
vi.mock("@/store/rtcStore", () => ({ useRtcStore: { getState: () => h.rtc, setState: (patch: any) => { Object.assign(h.rtc, patch); } }, activeRtcDoc: (s: any) => s.editingSubDocId
	? { ...s.doc, tracks: s.doc.subDocs[s.editingSubDocId].tracks } : s.doc }));
import { toggleRtcSupplement } from "./rtcSupplementActions";

const seg = (id: string, shotId: string): RtcSegment => ({ id, kind: "media", media: "video", targetStartUs: 0, targetDurationUs: 5_000_000,
	shotRef: { episodeId: "ep", shotId }, name: shotId === "s10" ? "分镜10" : "分镜1" });
const makeDoc = (parent = "s1"): RtcDoc => ({ id: "doc", name: "fixture", fps: 30, tracks: [
	{ id: "main", type: "video", segments: [seg("main", parent)] }, { id: "upper", type: "video", segments: [seg("upper", "s10")] },
] });
const input = { owner: "owner", episodeId: "ep", shotId: "s10", segId: "upper" };
const list = () => h.project.episodes[0].shots;
beforeEach(() => {
	h.project = { projectInstanceId: "owner", isProjectLoading: false, rtcEpisodeId: "ep", episodes: [{ id: "ep", shots: Array.from({ length: 10 }, (_, i) => ({
		id: `s${i + 1}`, index: i + 1, title: `分镜${i + 1}`, prompt: `p${i + 1}`, materials: [],
	})) }], save: vi.fn(async () => {}), setEpisodeShots: vi.fn((id: string, shots: any[]) => { h.project.episodes = h.project.episodes.map((e: any) => e.id === id ? { ...e, shots } : e); }) };
	h.rtc = { doc: makeDoc(), ownerProjectId: "owner", ownerEpisodeKey: "ep", editingSubDocId: null, past: [], future: [],
		patchSilent: vi.fn((mutator: (d: RtcDoc) => RtcDoc) => { h.rtc.doc = mutator(h.rtc.doc); }) };
});

describe("RTC supplement action", () => {
	it("updates the right shot and its automatic timeline name, then saves; closing clears binding", () => {
		expect(toggleRtcSupplement(input)).toEqual({ ok: true });
		expect(list()[9]).toMatchObject({ title: "分镜1-1", supplementParentId: "s1", supplementIndex: 1, prompt: "p10" });
		expect(h.rtc.doc.tracks[1].segments[0].name).toBe("分镜1-1");
		expect(h.project.setEpisodeShots).toHaveBeenCalledOnce(); expect(h.project.save).toHaveBeenCalledWith(true);
		expect(toggleRtcSupplement(input)).toEqual({ ok: true });
		expect(list()[9]).toMatchObject({ title: "分镜10", isSupplement: false }); expect(list()[9].supplementParentId).toBeUndefined();
		expect(h.rtc.doc.tracks[1].segments[0].name).toBe("分镜10");
	});
	it("uses the current compound's main track while preserving parent time windows", () => {
		h.rtc.doc.subDocs = { child: { id: "child", name: "child", tracks: makeDoc("s2").tracks } };
		h.rtc.editingSubDocId = "child";
		expect(toggleRtcSupplement(input)).toEqual({ ok: true }); expect(list()[9].title).toBe("分镜2-1");
		expect(h.rtc.doc.subDocs.child.tracks[1].segments[0].name).toBe("分镜2-1");
		expect(h.rtc.doc.tracks[0].segments[0].targetDurationUs).toBe(5_000_000);
	});
	it.each(["owner", "loading", "episode", "rtc-owner", "rtc-episode", "binding", "deleted"])("rejects stale %s without changing or saving", reason => {
		if (reason === "owner") h.project.projectInstanceId = "other";
		if (reason === "loading") h.project.isProjectLoading = true;
		if (reason === "episode") h.project.rtcEpisodeId = "other";
		if (reason === "rtc-owner") h.rtc.ownerProjectId = "other";
		if (reason === "rtc-episode") h.rtc.ownerEpisodeKey = "other";
		if (reason === "binding") h.rtc.doc.tracks[1].segments[0].shotRef.shotId = "s2";
		if (reason === "deleted") h.rtc.doc.tracks[1].segments = [];
		expect(toggleRtcSupplement(input)).toMatchObject({ ok: false, reason: expect.any(String) });
		expect(h.project.setEpisodeShots).not.toHaveBeenCalled(); expect(h.rtc.patchSilent).not.toHaveBeenCalled(); expect(h.project.save).not.toHaveBeenCalled();
	});
	it("returns the useful no-cover reason rather than toggling a misleading supplement flag", () => {
		h.rtc.doc.tracks[0].segments = [];
		expect(toggleRtcSupplement(input)).toEqual({ ok: false, reason: "素材起点没有对应的主轨镜头，无法设为补镜头。" });
		expect(list()[9].isSupplement).toBeUndefined(); expect(h.project.save).not.toHaveBeenCalled();
	});
});
