import { describe, expect, it } from "vitest";
import { pruneEmptyTracks } from "./rtcOps";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";

function seg(id: string): RtcSegment {
	return { id, kind: "media", media: "video", assetId: "a", uri: "u://a", targetStartUs: 0, targetDurationUs: 1_000_000 } as RtcSegment;
}
function track(id: string, type: RtcTrack["type"], segments: RtcSegment[], extra?: Partial<RtcTrack>): RtcTrack {
	return { id, type, segments, ...extra } as RtcTrack;
}
function doc(tracks: RtcTrack[]): RtcDoc {
	return { id: "d", name: "d", fps: 30, tracks } as RtcDoc;
}

describe("pruneEmptyTracks 空轨道自动回收", () => {
	it("空的非主轨被回收；有片段的轨保留", () => {
		// 主轨=第一条 video 轨（此处 main）；排在其后的空视频轨才是可回收对象
		const d = doc([
			track("t-text", "text", []),
			track("main", "video", [seg("s1")]),
			track("v2", "video", []),
			track("a1", "audio", []),
			track("a2", "audio", [seg("s2")]),
		]);
		const out = pruneEmptyTracks(d);
		expect(out.tracks.map((t) => t.id)).toEqual(["main", "a2"]);
	});

	it("主轨（第一条 video 轨）空了也保留——画幅骨架恒在", () => {
		const d = doc([track("main", "video", []), track("a1", "audio", [])]);
		const out = pruneEmptyTracks(d);
		expect(out.tracks.map((t) => t.id)).toEqual(["main"]);
	});

	it("锁定的空轨保留（用户显式锁=显式意图）", () => {
		const d = doc([track("main", "video", [seg("s1")]), track("v2", "video", [], { locked: true }), track("a1", "audio", [])]);
		const out = pruneEmptyTracks(d);
		expect(out.tracks.map((t) => t.id)).toEqual(["main", "v2"]);
	});

	it("无可清时返回原引用（commit no-op 语义）", () => {
		const d = doc([track("main", "video", [seg("s1")]), track("a1", "audio", [seg("s2")])]);
		expect(pruneEmptyTracks(d)).toBe(d);
	});

	it("全空且无 video 轨：至少留第一条轨（时间轴不空壳）", () => {
		const d = doc([track("a1", "audio", []), track("a2", "audio", [])]);
		const out = pruneEmptyTracks(d);
		expect(out.tracks.map((t) => t.id)).toEqual(["a1"]);
	});
});
