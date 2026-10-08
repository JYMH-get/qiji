import { afterEach, expect, it, vi } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import type { RtcDoc } from "@/types/rtc";
import { toggleRtcSupplement } from "./rtcSupplementActions";

const originalSave = useProjectStore.getState().save;
afterEach(() => useProjectStore.setState({ save: originalSave }));

it("real stores retain derived numbering across existing edit undo/redo, then close normally", () => {
	useProjectStore.setState({
		projectInstanceId: "supplement-history-owner", isProjectLoading: false, savePath: null, rtcEpisodeId: "ep", rtcDocs: {},
		episodes: [{ id: "ep", index: 1, title: "episode", scriptText: "", shots: Array.from({ length: 10 }, (_, i) => ({
			id: `s${i + 1}`, index: i + 1, title: `分镜${i + 1}`, prompt: "", materials: [],
		})) }], save: vi.fn(async () => {}),
	});
	const doc: RtcDoc = { id: "doc", name: "fixture", fps: 30, tracks: [
		{ id: "main", type: "video", segments: [{ id: "main", kind: "media", media: "video", targetStartUs: 0, targetDurationUs: 10_000_000, shotRef: { episodeId: "ep", shotId: "s1" } }] },
		{ id: "upper", type: "video", segments: [{ id: "upper", kind: "media", media: "video", targetStartUs: 0, targetDurationUs: 3_000_000, shotRef: { episodeId: "ep", shotId: "s10" }, name: "分镜10" }] },
	] };
	useRtcStore.getState().loadDoc(doc);
	const move = (start: number) => useRtcStore.getState().commit(d => ({ ...d, tracks: d.tracks.map(t => t.id !== "upper" ? t : {
		...t, segments: t.segments.map(s => ({ ...s, targetStartUs: start })),
	}) }));
	move(2_000_000); move(3_000_000); useRtcStore.getState().undo();
	expect(useRtcStore.getState().past).toHaveLength(1); expect(useRtcStore.getState().future).toHaveLength(1);
	const input = { owner: "supplement-history-owner", episodeId: "ep", shotId: "s10", segId: "upper" };
	expect(toggleRtcSupplement(input)).toEqual({ ok: true });
	const state = useRtcStore.getState();
	expect(state.past).toHaveLength(1); expect(state.future).toHaveLength(1);
	for (const d of [state.doc!, ...state.past, ...state.future]) expect(d.tracks[1].segments[0].name).toBe("分镜1-1");
	const check = (start: number, title: string) => {
		expect(useRtcStore.getState().doc!.tracks[1].segments[0]).toMatchObject({ targetStartUs: start, name: title });
		expect(useProjectStore.getState().episodes[0].shots[9].title).toBe(title);
	};
	useRtcStore.getState().undo(); check(0, "分镜1-1");
	useRtcStore.getState().redo(); check(2_000_000, "分镜1-1");
	useRtcStore.getState().redo(); check(3_000_000, "分镜1-1");
	expect(toggleRtcSupplement(input)).toEqual({ ok: true }); check(3_000_000, "分镜10");
	useRtcStore.getState().undo(); check(2_000_000, "分镜10");
	expect(useProjectStore.getState().episodes[0].shots[9].supplementParentId).toBeUndefined();
});
