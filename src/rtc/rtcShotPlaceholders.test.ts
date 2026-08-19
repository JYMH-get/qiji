import { describe, expect, it } from "vitest";
import {
	DEFAULT_SHOT_DUR_US,
	appendEpisodePlaceholders,
	collectShotRefKeys,
	shotDurationUs,
	shotSegmentName,
} from "./rtcShotPlaceholders";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import type { StoryboardShot, VideoEpisode } from "@/services/projectFile";

const SEC = 1_000_000;

function shot(id: string, index: number, extra: Partial<StoryboardShot> = {}): StoryboardShot {
	return { id, index, title: `分镜${index}`, prompt: "", materials: [], ...extra };
}

function episode(id: string, index: number, shots: StoryboardShot[]): VideoEpisode {
	return { id, index, title: `${String(index).padStart(3, "0")}-第${index}集`, scriptText: "", shots };
}

function doc(...tracks: Array<{ id: string; type?: "video" | "audio" | "text"; segments: RtcSegment[] }>): RtcDoc {
	return {
		id: "d1",
		name: "t",
		fps: 30,
		tracks: tracks.map((t) => ({ id: t.id, type: t.type ?? "video", segments: t.segments })),
	};
}

function seg(id: string, startUs: number, durUs: number, extra: Partial<RtcSegment> = {}): RtcSegment {
	return { id, kind: "media", media: "video", targetStartUs: startUs, targetDurationUs: durUs, ...extra };
}

/** 全部片段（跨轨摊平） */
function allSegs(d: RtcDoc): RtcSegment[] {
	return d.tracks.flatMap((t) => t.segments);
}

describe("shotDurationUs / shotSegmentName", () => {
	it("durationSec 换微秒；缺省 3s；非法/非正回退缺省；极小值钳 MIN 以上", () => {
		expect(shotDurationUs({ durationSec: 5 })).toBe(5 * SEC);
		expect(shotDurationUs({ durationSec: 1.5 })).toBe(1_500_000);
		expect(shotDurationUs({})).toBe(DEFAULT_SHOT_DUR_US);
		expect(shotDurationUs({ durationSec: 0 })).toBe(DEFAULT_SHOT_DUR_US);
		expect(shotDurationUs({ durationSec: -3 })).toBe(DEFAULT_SHOT_DUR_US);
		expect(shotDurationUs({ durationSec: Number.NaN })).toBe(DEFAULT_SHOT_DUR_US);
		expect(shotDurationUs({ durationSec: 0.0000001 })).toBe(1000); // 0.1µs → 钳 MIN=1000µs
	});

	it("命名与 rtcAssetData 同规：单集=标题、多集=「N集·标题」、标题缺省退 index", () => {
		expect(shotSegmentName({ title: "分镜2", index: 2 }, 1, false)).toBe("分镜2");
		expect(shotSegmentName({ title: "分镜2", index: 2 }, 3, true)).toBe("3集·分镜2");
		expect(shotSegmentName({ title: "  ", index: 7 }, 1, false)).toBe("分镜7");
	});
});

describe("appendEpisodePlaceholders 顺序与起点接续", () => {
	it("空轨从 0 起按顺序接续，时长各按 durationSec", () => {
		const ep = episode("e1", 1, [shot("s1", 1, { durationSec: 5 }), shot("s2", 2, { durationSec: 2 }), shot("s3", 3)]);
		const { doc: d2, added, skipped } = appendEpisodePlaceholders(doc({ id: "t1", segments: [] }), ep);
		expect(added).toBe(3);
		expect(skipped).toBe(0);
		const segs = d2.tracks[0].segments;
		expect(segs.map((s) => s.targetStartUs)).toEqual([0, 5 * SEC, 7 * SEC]);
		expect(segs.map((s) => s.targetDurationUs)).toEqual([5 * SEC, 2 * SEC, DEFAULT_SHOT_DUR_US]);
		expect(segs.every((s) => s.kind === "placeholder")).toBe(true);
		expect(segs.map((s) => s.name)).toEqual(["分镜1", "分镜2", "分镜3"]);
		expect(segs[0].shotRef).toEqual({ episodeId: "e1", shotId: "s1" });
	});

	it("起点=第一条 video 轨末尾片段结束处（不假定排序，取最大右缘）", () => {
		const base = doc({ id: "t1", segments: [seg("m1", 2 * SEC, 3 * SEC), seg("m0", 0, SEC)] });
		const ep = episode("e1", 1, [shot("s1", 1, { durationSec: 4 })]);
		const { doc: d2 } = appendEpisodePlaceholders(base, ep);
		const added = d2.tracks[0].segments.find((s) => s.shotRef?.shotId === "s1");
		expect(added?.targetStartUs).toBe(5 * SEC);
	});

	it("无 video 轨则新建（既有 audio 轨不动；目标=第一条 video 轨）", () => {
		const base = doc({ id: "a1", type: "audio", segments: [] });
		const ep = episode("e1", 1, [shot("s1", 1)]);
		const { doc: d2 } = appendEpisodePlaceholders(base, ep);
		expect(d2.tracks).toHaveLength(2);
		expect(d2.tracks[0].type).toBe("audio");
		expect(d2.tracks[0].segments).toHaveLength(0);
		expect(d2.tracks[1].type).toBe("video");
		expect(d2.tracks[1].segments).toHaveLength(1);
		expect(d2.tracks[1].segments[0].targetStartUs).toBe(0);
	});

	it("多集命名「N集·分镜N」", () => {
		const ep = episode("e2", 2, [shot("s1", 1)]);
		const { doc: d2 } = appendEpisodePlaceholders(doc({ id: "t1", segments: [] }), ep, { multiEp: true });
		expect(d2.tracks[0].segments[0].name).toBe("2集·分镜1");
	});
});

describe("appendEpisodePlaceholders 幂等（按 shotRef 判定）", () => {
	it("重复追加同一分集：全部跳过、返回原 doc 引用（commit no-op）", () => {
		const ep = episode("e1", 1, [shot("s1", 1), shot("s2", 2)]);
		const first = appendEpisodePlaceholders(doc({ id: "t1", segments: [] }), ep);
		const second = appendEpisodePlaceholders(first.doc, ep);
		expect(second.added).toBe(0);
		expect(second.skipped).toBe(2);
		expect(second.doc).toBe(first.doc); // 原引用
	});

	it("已被替换成 media 的片段（shotRef 仍在）同样算已存在——任意轨都算", () => {
		const swapped = seg("m1", 0, 5 * SEC, { shotRef: { episodeId: "e1", shotId: "s1" }, uri: "u1" });
		const base = doc({ id: "t1", segments: [] }, { id: "t2", segments: [swapped] });
		const ep = episode("e1", 1, [shot("s1", 1), shot("s2", 2, { durationSec: 2 })]);
		const { doc: d2, added, skipped } = appendEpisodePlaceholders(base, ep);
		expect(added).toBe(1);
		expect(skipped).toBe(1);
		// 只追加了 s2，且仍落第一条 video 轨（t1，空轨从 0）
		const fresh = d2.tracks[0].segments;
		expect(fresh).toHaveLength(1);
		expect(fresh[0].shotRef).toEqual({ episodeId: "e1", shotId: "s2" });
		expect(fresh[0].targetStartUs).toBe(0);
		expect(allSegs(d2).filter((s) => s.shotRef?.shotId === "s1")).toHaveLength(1); // 绝不重复
	});

	it("不同分集的同名 shotId 不互相误判（键=episodeId+shotId）", () => {
		const ep1 = episode("e1", 1, [shot("s1", 1)]);
		const ep2 = episode("e2", 2, [shot("s1", 1)]);
		const r1 = appendEpisodePlaceholders(doc({ id: "t1", segments: [] }), ep1);
		const r2 = appendEpisodePlaceholders(r1.doc, ep2);
		expect(r2.added).toBe(1);
		expect(r2.skipped).toBe(0);
		expect(collectShotRefKeys(r2.doc).size).toBe(2);
	});
});

describe("appendEpisodePlaceholders 成片直落 media", () => {
	it("shot.videoUri 存在 → kind:media + assetId 反查 + source=[0, durationSec µs]", () => {
		const ep = episode("e1", 1, [shot("s1", 1, { durationSec: 6, videoUri: "local://v1.mp4" }), shot("s2", 2)]);
		const resolveBlob = (uri: string) => (uri === "local://v1.mp4" ? { id: "video00000042", url: "https://oss/v1.mp4" } : undefined);
		const { doc: d2, added } = appendEpisodePlaceholders(doc({ id: "t1", segments: [] }), ep, { resolveBlob });
		expect(added).toBe(2);
		const [a, b] = d2.tracks[0].segments;
		expect(a.kind).toBe("media");
		expect(a.media).toBe("video");
		expect(a.assetId).toBe("video00000042");
		expect(a.uri).toBe("local://v1.mp4");
		expect(a.sourceStartUs).toBe(0);
		expect(a.sourceDurationUs).toBe(6 * SEC);
		expect(a.targetStartUs).toBe(0);
		expect(a.targetDurationUs).toBe(6 * SEC);
		expect(a.shotRef).toEqual({ episodeId: "e1", shotId: "s1" });
		// 后镜是普通占位符，起点接在成片之后
		expect(b.kind).toBe("placeholder");
		expect(b.targetStartUs).toBe(6 * SEC);
	});

	it("台账反查不到 → media 片段不带 assetId（uri 照存）；无 resolve 回调同理", () => {
		const ep = episode("e1", 1, [shot("s1", 1, { videoUri: "local://v2.mp4" })]);
		const { doc: d2 } = appendEpisodePlaceholders(doc({ id: "t1", segments: [] }), ep, { resolveBlob: () => undefined });
		expect(d2.tracks[0].segments[0].kind).toBe("media");
		expect("assetId" in d2.tracks[0].segments[0]).toBe(false);
		const { doc: d3 } = appendEpisodePlaceholders(doc({ id: "t1", segments: [] }), ep);
		expect(d3.tracks[0].segments[0].assetId).toBeUndefined();
	});
});

describe("appendEpisodePlaceholders 空分集", () => {
	it("shots 为空：added=skipped=0，返回原 doc 引用", () => {
		const base = doc({ id: "t1", segments: [] });
		const r = appendEpisodePlaceholders(base, episode("e1", 1, []));
		expect(r.added).toBe(0);
		expect(r.skipped).toBe(0);
		expect(r.doc).toBe(base);
	});
});

describe("原文不落轨（补充10：派生只读，rtcScriptLane 另测）", () => {
	it("占位入轨不再产生任何 role:\"script\" 轨/片段（有原文的分镜也一样）", () => {
		const ep = episode("e1", 1, [shot("s1", 1, { durationSec: 5, scriptSegment: "第一镜原文" }), shot("s2", 2)]);
		const { doc: d2, added } = appendEpisodePlaceholders(doc({ id: "t1", segments: [] }), ep);
		expect(added).toBe(2);
		expect(d2.tracks).toHaveLength(1);
		expect(d2.tracks.some((t) => t.role === "script")).toBe(false);
	});

	it("collectShotRefKeys 不收旧形态原文轨（未清洗 doc 的防御：不让视频占位误判「已在轨」）", () => {
		const d: RtcDoc = {
			id: "d1", name: "t", fps: 30,
			tracks: [{ id: "tx", type: "text", role: "script", segments: [seg("o1", 0, SEC, { shotRef: { episodeId: "e1", shotId: "s1" }, text: { content: "x" } })] }],
		};
		expect(collectShotRefKeys(d).size).toBe(0);
	});
});
