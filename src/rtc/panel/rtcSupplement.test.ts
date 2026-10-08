import { describe, expect, it } from "vitest";
import type { StoryboardShot } from "@/services/projectFile";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { planRtcSupplement, renameRtcShotTitles } from "./rtcSupplement";

const S = 1_000_000;
const shot = (n: number, extra: Partial<StoryboardShot> = {}): StoryboardShot => ({ id: `sh${n}`, index: n, title: `分镜${n}`, prompt: `prompt${n}`, materials: [], ...extra });
const seg = (id: string, shotId: string, start = 0, duration = 5, name?: string): RtcSegment => ({ id, kind: "media", media: "video", uri: "fixture://video", targetStartUs: start * S, targetDurationUs: duration * S, shotRef: { episodeId: "ep", shotId }, name });
const doc = (main = [seg("main", "sh1")], upper = [seg("upper", "sh10", 1, 3, "分镜10")]): RtcDoc => ({ id: "doc", name: "fixture", fps: 30, tracks: [
	{ id: "main", type: "video", segments: main }, { id: "upper", type: "video", segments: upper },
] });
const shots = () => Array.from({ length: 10 }, (_, i) => shot(i + 1));
function plan(d = doc(), list = shots(), enabled = true) { return planRtcSupplement({ doc: d, shots: list, episodeId: "ep", shotId: "sh10", segId: "upper", enabled }); }

describe("RTC supplement parent comes from timeline position", () => {
	it("upper shot10 covering main shot1 becomes shot1-1 without changing order, prompts or results", () => {
		const list = shots(); list[9] = { ...list[9], videoUris: ["result"], materials: [{ id: "mat", media: "image" } as any] };
		const before = doc(), result = plan(before, list);
		expect(result.ok).toBe(true); if (!result.ok) return;
		expect(result.shots.map(s => s.id)).toEqual(list.map(s => s.id));
		expect(result.shots[9]).toMatchObject({ title: "分镜1-1", isSupplement: true, supplementParentId: "sh1", supplementIndex: 1, prompt: "prompt10", videoUris: ["result"], materials: list[9].materials });
		expect(list[9].title).toBe("分镜10"); expect(before.tracks[1].segments[0].targetStartUs).toBe(S);
	});
	it("allocates later supplements from the same parent's existing maximum, including legacy entries", () => {
		const first = plan(); if (!first.ok) throw new Error(first.reason);
		const list = [...first.shots, shot(11)];
		const d = doc(undefined, [seg("second", "sh11", 2)]);
		const second = planRtcSupplement({ doc: d, shots: list, episodeId: "ep", shotId: "sh11", segId: "second", enabled: true });
		expect(second.ok).toBe(true); if (!second.ok) return;
		expect(second.shots.find(s => s.id === "sh10")?.title).toBe("分镜1-1");
		expect(second.shots.find(s => s.id === "sh11")?.title).toBe("分镜1-2");
		const legacy = [shot(1), shot(2, { isSupplement: true, title: "分镜1-1" }), shot(10)];
		const mixed = plan(doc(), legacy); if (!mixed.ok) throw new Error(mixed.reason);
		expect(mixed.shots[2].title).toBe("分镜1-2");
	});
	it("uses the start instant with an open right edge and follows a supplement's valid main parent", () => {
		const d = doc([seg("first", "sh1", 0, 5), seg("next", "sh2", 5, 5)], [seg("upper", "sh10", 5)]);
		const result = plan(d); if (!result.ok) throw new Error(result.reason);
		expect(result.shots[9].supplementParentId).toBe("sh2");
		const nested = plan(doc([seg("main", "sh2")]), [shot(1), shot(2, { isSupplement: true }), shot(10)]);
		if (!nested.ok) throw new Error(nested.reason);
		expect(nested.shots[2]).toMatchObject({ supplementParentId: "sh1", title: "分镜1-2" });
	});
	it.each(["gap", "unbound", "self", "overlap", "other-episode", "orphan"])("rejects %s without any data changes", mode => {
		const d = doc(), list = shots();
		if (mode === "gap") d.tracks[0].segments[0].targetStartUs = 8 * S;
		if (mode === "unbound") d.tracks[0].segments[0].shotRef = undefined;
		if (mode === "self") d.tracks[0].segments[0].shotRef!.shotId = "sh10";
		if (mode === "overlap") d.tracks[0].segments.push(seg("overlap", "sh2"));
		if (mode === "other-episode") d.tracks[0].segments[0].shotRef!.episodeId = "other";
		if (mode === "orphan") list[0] = { ...list[0], isSupplement: true, supplementParentId: "gone", supplementIndex: 1 };
		const snapshot = JSON.stringify({ d, list });
		expect(plan(d, list)).toMatchObject({ ok: false, reason: expect.any(String) }); expect(JSON.stringify({ d, list })).toBe(snapshot);
	});
	it("closing needs no parent coverage and clears both bindings using established ordinary reindex", () => {
		const first = plan(); if (!first.ok) throw new Error(first.reason);
		const result = plan(doc([], [seg("upper", "sh10")]), first.shots, false);
		if (!result.ok) throw new Error(result.reason);
		expect(result.shots[9]).toMatchObject({ title: "分镜10", isSupplement: false });
		expect(result.shots[9].supplementParentId).toBeUndefined(); expect(result.shots[9].supplementIndex).toBeUndefined();
	});
	it("only renames automatic same-episode segment names in root and child documents", () => {
		const list = shots(), result = plan(doc(), list); if (!result.ok) throw new Error(result.reason);
		const d = doc(undefined, [seg("auto", "sh10", 0, 5, "分镜10"), seg("custom", "sh10", 5, 5, "自定义名称"),
			{ ...seg("other-ep", "sh10", 10, 5, "分镜10"), shotRef: { episodeId: "other", shotId: "sh10" } }]);
		d.subDocs = { child: { id: "child", name: "child", tracks: [{ id: "cv", type: "video", segments: [seg("child-seg", "sh10")] }] } };
		const next = renameRtcShotTitles(d, "ep", list, result.shots);
		expect(next.tracks[1].segments.map(s => s.name)).toEqual(["分镜1-1", "自定义名称", "分镜10"]);
		expect(next.subDocs?.child.tracks[0].segments[0].name).toBe("分镜1-1"); expect(next.tracks[0]).toBe(d.tracks[0]);
		expect(renameRtcShotTitles(next, "ep", result.shots, result.shots)).toBe(next);
	});
});
