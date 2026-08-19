import { describe, expect, it } from "vitest";
import {
	MIN_SEGMENT_US,
	addSegment,
	addTrack,
	docDurationUs,
	formatTimecode,
	gapInsertIndex,
	gapLegalForType,
	insertTrackAt,
	mainVideoTrackId,
	moveSegment,
	nearestLegalGap,
	formatEditableTime,
	frameDurationUs,
	nearestSnap,
	orderTracksForDisplay,
	parseTimecodeInput,
	pasteSegments,
	pruneScriptTracks,
	removeSegments,
	removeTrack,
	reorderTracks,
	replaceSegmentMedia,
	rippleDeleteSegments,
	rulerStepUs,
	setSegmentSpeed,
	stepPlayheadUs,
	setTrackProps,
	snapCandidates,
	snapSegmentStart,
	splitSegment,
	trackTypeForMedia,
	trimSegment,
} from "./rtcOps";
import type { RtcDoc, RtcSegment } from "@/types/rtc";

const SEC = 1_000_000;

function seg(id: string, startUs: number, durUs: number, extra: Partial<RtcSegment> = {}): RtcSegment {
	return { id, kind: "media", media: "video", targetStartUs: startUs, targetDurationUs: durUs, ...extra };
}

function doc(...tracks: Array<{ id: string; type?: "video" | "audio" | "text"; segments: RtcSegment[] }>): RtcDoc {
	return {
		id: "d1",
		name: "t",
		fps: 30,
		tracks: tracks.map((t) => ({ id: t.id, type: t.type ?? "video", segments: t.segments })),
	};
}

describe("rtcOps 轨道操作", () => {
	it("addTrack 按类型优先级插入（text<video<audio）", () => {
		const d = doc({ id: "t1", type: "audio", segments: [] });
		const d2 = addTrack(d, "video");
		expect(d2.tracks).toHaveLength(2);
		expect(d2.tracks[0].type).toBe("video"); // video(1) < audio(2)，插到前面
		const d3 = addTrack(d2, "text");
		expect(d3.tracks).toHaveLength(3);
		expect(d3.tracks[0].type).toBe("text"); // text(0) 最前
		expect(d3.tracks[1].type).toBe("video");
		expect(d3.tracks[2].type).toBe("audio");
	});

	it("reorderTracks 重排 / 未命中返回原引用", () => {
		const d = doc(
			{ id: "t1", type: "video", segments: [] },
			{ id: "t2", type: "audio", segments: [] },
			{ id: "t3", type: "text", segments: [] },
		);
		const d2 = reorderTracks(d, ["t3", "t1", "t2"]);
		expect(d2.tracks.map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
		expect(reorderTracks(d, ["nope"])).toBe(d); // 未命中=原引用
	});

	it("removeTrack 未命中返回原引用；⚠ 主轨不可删（第236轮后续：剪映式轨道分层）", () => {
		const d = doc(
			{ id: "v1", type: "video", segments: [] },
			{ id: "v2", type: "video", segments: [] },
			{ id: "a1", type: "audio", segments: [] },
		);
		expect(removeTrack(d, "nope")).toBe(d);
		expect(removeTrack(d, "v1")).toBe(d); // v1=主轨（第一条 video 轨）→ no-op 原引用
		expect(removeTrack(d, "v2").tracks.map((t) => t.id)).toEqual(["v1", "a1"]);
		expect(removeTrack(d, "a1").tracks.map((t) => t.id)).toEqual(["v1", "v2"]);
		// 唯一一条轨且是 video → 它就是主轨，删不掉
		const only = doc({ id: "t1", type: "video", segments: [] });
		expect(removeTrack(only, "t1")).toBe(only);
	});

	it("setTrackProps 改 muted/locked；未命中返回原引用", () => {
		const d = doc({ id: "t1", segments: [] });
		expect(setTrackProps(d, "t1", { muted: true }).tracks[0].muted).toBe(true);
		expect(setTrackProps(d, "nope", { muted: true })).toBe(d);
	});
});

/* 剪映式轨道分层（主轨 / 显示序 / 缝隙）——显示序只排 UI，doc.tracks 数组序是数据层真相 */
describe("rtcOps 轨道分层", () => {
	/** 常用布局：文本 tx1 + 视频 v1(主轨) v2 v3（v3 最晚建）+ 音频 a1 a2 */
	const layout = doc(
		{ id: "tx1", type: "text", segments: [] },
		{ id: "v1", type: "video", segments: [] },
		{ id: "v2", type: "video", segments: [] },
		{ id: "v3", type: "video", segments: [] },
		{ id: "a1", type: "audio", segments: [] },
		{ id: "a2", type: "audio", segments: [] },
	);

	it("mainVideoTrackId = 数组里第一条 video 轨；无视频轨为 null", () => {
		expect(mainVideoTrackId(layout.tracks)).toBe("v1");
		expect(mainVideoTrackId(doc({ id: "a1", type: "audio", segments: [] }).tracks)).toBeNull();
		// 数组序才算数：即便音频排在前面，第一条 video 仍是主轨
		expect(mainVideoTrackId(doc(
			{ id: "a1", type: "audio", segments: [] },
			{ id: "v9", type: "video", segments: [] },
		).tracks)).toBe("v9");
	});

	it("orderTracksForDisplay：文本 → 非主视频轨（越晚建越靠上）→ 主轨 → 音频；不改 doc.tracks", () => {
		expect(orderTracksForDisplay(layout.tracks).map((t) => t.id)).toEqual(["tx1", "v3", "v2", "v1", "a1", "a2"]);
		expect(layout.tracks.map((t) => t.id)).toEqual(["tx1", "v1", "v2", "v3", "a1", "a2"]); // 原数组未被重排
		// 无视频轨时不产生空洞
		expect(orderTracksForDisplay(doc(
			{ id: "a1", type: "audio", segments: [] },
			{ id: "tx1", type: "text", segments: [] },
		).tracks).map((t) => t.id)).toEqual(["tx1", "a1"]);
	});

	it("gapLegalForType：分层不能被破坏；⚠ 主轨下方的缝隙对 video 非法", () => {
		// 显示行：0=tx1 1=v3 2=v2 3=v1(主轨) 4=a1 5=a2 → 缝隙 0..6
		const legal = (gap: number, type: "video" | "audio" | "text") => gapLegalForType(layout.tracks, gap, type);
		// video：视频组内部与「文本/视频」边界合法，主轨下方（缝隙 4）起一律非法
		expect([0, 1, 2, 3, 4, 5, 6].map((g) => legal(g, "video"))).toEqual([false, true, true, true, false, false, false]);
		// text：文本组内与「文本/视频」边界合法
		expect([0, 1, 2, 3, 4, 5, 6].map((g) => legal(g, "text"))).toEqual([true, true, false, false, false, false, false]);
		// audio：「视频/音频」边界（缝隙 4）起到最底合法
		expect([0, 1, 2, 3, 4, 5, 6].map((g) => legal(g, "audio"))).toEqual([false, false, false, false, true, true, true]);
		// 越界缝隙一律非法
		expect(legal(-1, "video")).toBe(false);
		expect(legal(7, "audio")).toBe(false);
	});

	it("nearestLegalGap：轨道区外的落点收敛到最近合法缝隙（底部空白拖视频 → 主轨上方）", () => {
		expect(nearestLegalGap(layout.tracks, 6, "audio")).toBe(6); // 底部空白拖音频 = 最底
		expect(nearestLegalGap(layout.tracks, 6, "video")).toBe(3); // 底部空白拖视频 = 主轨上方（绝不越到主轨之下）
		expect(nearestLegalGap(layout.tracks, 0, "video")).toBe(1); // 顶部（标尺上方）→ 视频组最上
		expect(nearestLegalGap(layout.tracks, 6, "text")).toBe(1);
		// 空文档：唯一缝隙 0 对任何类型都合法
		expect(nearestLegalGap([], 3, "video")).toBe(0);
	});

	it("gapInsertIndex：显示序缝隙 → doc.tracks 插入位（视频组显示是数组倒序）", () => {
		// 视频：缝隙 1（v3 之上）→ 视频组数组末端 4；缝隙 2（v3/v2 之间）→ v3 的下标 3；缝隙 3（v2/主轨之间）→ v2 的下标 2
		expect(gapInsertIndex(layout.tracks, 1, "video")).toBe(4);
		expect(gapInsertIndex(layout.tracks, 2, "video")).toBe(3);
		expect(gapInsertIndex(layout.tracks, 3, "video")).toBe(2);
		// 文本/音频显示序=数组序：插在 below 之前
		expect(gapInsertIndex(layout.tracks, 0, "text")).toBe(0);
		expect(gapInsertIndex(layout.tracks, 1, "text")).toBe(1); // 文本组末端
		expect(gapInsertIndex(layout.tracks, 4, "audio")).toBe(4); // a1 之前
		expect(gapInsertIndex(layout.tracks, 5, "audio")).toBe(5); // a1/a2 之间
		expect(gapInsertIndex(layout.tracks, 6, "audio")).toBe(6); // 最底
	});

	it("gapInsertIndex + insertTrackAt 往返：新轨恰好落在用户看到的那条缝隙上", () => {
		const place = (gap: number, type: "video" | "audio" | "text") =>
			orderTracksForDisplay(
				insertTrackAt(layout, type, gapInsertIndex(layout.tracks, gap, type), { id: "NEW" }).tracks,
			).map((t) => t.id);
		expect(place(1, "video")).toEqual(["tx1", "NEW", "v3", "v2", "v1", "a1", "a2"]);
		expect(place(2, "video")).toEqual(["tx1", "v3", "NEW", "v2", "v1", "a1", "a2"]);
		expect(place(3, "video")).toEqual(["tx1", "v3", "v2", "NEW", "v1", "a1", "a2"]); // 主轨仍压底
		expect(place(0, "text")).toEqual(["NEW", "tx1", "v3", "v2", "v1", "a1", "a2"]);
		expect(place(4, "audio")).toEqual(["tx1", "v3", "v2", "v1", "NEW", "a1", "a2"]);
		expect(place(6, "audio")).toEqual(["tx1", "v3", "v2", "v1", "a1", "a2", "NEW"]);
	});

	it("insertTrackAt：越界钳位；⚠ 新 video 轨恒插在主轨之后（绝不抢占主轨身份）", () => {
		const d = insertTrackAt(layout, "video", 0, { id: "NEW" }); // 落点 0 在主轨之前 → 钳到主轨之后
		expect(d.tracks.map((t) => t.id)).toEqual(["tx1", "v1", "NEW", "v2", "v3", "a1", "a2"]);
		expect(mainVideoTrackId(d.tracks)).toBe("v1"); // 主轨身份不变
		const appended = insertTrackAt(layout, "audio", 999, { id: "NEW" }).tracks;
		expect(appended[appended.length - 1].id).toBe("NEW");
		expect(insertTrackAt(layout, "text", -5, { id: "NEW" }).tracks[0].id).toBe("NEW");
		// 无视频轨时 video 可落在任意位置（此时它自己成为主轨）
		const empty = doc({ id: "a1", type: "audio", segments: [] });
		expect(mainVideoTrackId(insertTrackAt(empty, "video", 0, { id: "NEW" }).tracks)).toBe("NEW");
	});

	it("addTrack 新 video 轨落在视频组末端 = 主轨身份不变、显示在视频组最上", () => {
		const d = addTrack(layout, "video", "新视频轨");
		expect(mainVideoTrackId(d.tracks)).toBe("v1");
		expect(d.tracks.map((t) => t.type)).toEqual(["text", "video", "video", "video", "video", "audio", "audio"]);
		expect(orderTracksForDisplay(d.tracks)[1].name).toBe("新视频轨"); // 文本之下、其余视频之上
	});
});

describe("rtcOps 夹到最近空隙", () => {
	it("期望位置空闲即原样落位", () => {
		const d = addSegment(doc({ id: "t1", segments: [] }), "t1", seg("a", 2 * SEC, 3 * SEC));
		expect(d.tracks[0].segments[0].targetStartUs).toBe(2 * SEC);
	});

	it("被占时钳到最近合法起点（不推挤既有片段）", () => {
		const base = doc({ id: "t1", segments: [seg("a", 0, 5 * SEC), seg("b", 6 * SEC, 5 * SEC)] });
		// 期望 1s，落不下（0-5s 被占、5-6s 空隙只有 1s 放不下 3s）→ 尾部 11s 与 desired 差 10s；
		// 5-6s 空隙放不下；最近合法起点是尾部 11s？不——3s 片段哪儿都放不进 5-6s，唯一空隙是尾部
		const d = addSegment(base, "t1", seg("c", 1 * SEC, 3 * SEC));
		const c = d.tracks[0].segments.find((s) => s.id === "c")!;
		expect(c.targetStartUs).toBe(11 * SEC);
		// 既有片段没动
		expect(d.tracks[0].segments.find((s) => s.id === "a")!.targetStartUs).toBe(0);
		expect(d.tracks[0].segments.find((s) => s.id === "b")!.targetStartUs).toBe(6 * SEC);
	});

	it("放得下的中间空隙优先于更远的尾部；轨道内恒按 targetStartUs 升序", () => {
		const base = doc({ id: "t1", segments: [seg("a", 0, 5 * SEC), seg("b", 6 * SEC, 5 * SEC)] });
		const d = addSegment(base, "t1", seg("c", 4 * SEC, 1 * SEC)); // 1s 片段，5-6s 空隙可容纳
		const ids = d.tracks[0].segments.map((s) => s.id);
		expect(ids).toEqual(["a", "c", "b"]);
		expect(d.tracks[0].segments[1].targetStartUs).toBe(5 * SEC);
	});

	it("时长低于 MIN_SEGMENT_US 被钳到下限；轨道未命中返回原引用", () => {
		const base = doc({ id: "t1", segments: [] });
		const d = addSegment(base, "t1", seg("a", 0, 10));
		expect(d.tracks[0].segments[0].targetDurationUs).toBe(MIN_SEGMENT_US);
		expect(addSegment(base, "nope", seg("a", 0, SEC))).toBe(base);
	});
});

describe("rtcOps moveSegment", () => {
	const base = doc(
		{ id: "t1", segments: [seg("a", 0, 2 * SEC), seg("b", 3 * SEC, 2 * SEC)] },
		{ id: "t2", segments: [seg("x", 0, 4 * SEC)] },
	);

	it("同轨移动：把自己排除后找空隙", () => {
		const d = moveSegment(base, "a", "t1", 5 * SEC + 500_000);
		const a = d.tracks[0].segments.find((s) => s.id === "a")!;
		expect(a.targetStartUs).toBe(5 * SEC + 500_000);
	});

	it("跨轨移动：源轨移除、目标轨落位且被占则夹隙", () => {
		const d = moveSegment(base, "a", "t2", 1 * SEC);
		expect(d.tracks[0].segments.map((s) => s.id)).toEqual(["b"]);
		const a = d.tracks[1].segments.find((s) => s.id === "a")!;
		expect(a.targetStartUs).toBe(4 * SEC); // 0-4s 被 x 占，钳到 x 右缘
	});

	it("片段/目标轨未命中返回原引用", () => {
		expect(moveSegment(base, "nope", "t1", 0)).toBe(base);
		expect(moveSegment(base, "a", "nope", 0)).toBe(base);
	});
});

describe("rtcOps trimSegment", () => {
	// a=[2s,4s) 源窗口 [1s,3s)；b=[5s,7s) 源窗口 [0,2s)
	const withSource = doc({
		id: "t1",
		segments: [
			seg("a", 2 * SEC, 2 * SEC, { sourceStartUs: 1 * SEC, sourceDurationUs: 2 * SEC }),
			seg("b", 5 * SEC, 2 * SEC, { sourceStartUs: 0, sourceDurationUs: 2 * SEC }),
		],
	});

	it("左缘收缩：target 与 source 窗口联动", () => {
		const d = trimSegment(withSource, "a", "start", 500_000);
		const a = d.tracks[0].segments.find((s) => s.id === "a")!;
		expect(a.targetStartUs).toBe(2_500_000);
		expect(a.targetDurationUs).toBe(1_500_000);
		expect(a.sourceStartUs).toBe(1_500_000);
		expect(a.sourceDurationUs).toBe(1_500_000);
	});

	it("左缘外扩受 sourceStartUs≥0 约束（时间轴 0 之前还有富余也不越源头）", () => {
		const d = trimSegment(withSource, "a", "start", -5 * SEC);
		const a = d.tracks[0].segments.find((s) => s.id === "a")!;
		expect(a.targetStartUs).toBe(1 * SEC); // 源窗口只剩 1s 头部余量
		expect(a.targetDurationUs).toBe(3 * SEC);
		expect(a.sourceStartUs).toBe(0);
		expect(a.sourceDurationUs).toBe(3 * SEC);
	});

	it("右缘外扩不越后片段左缘；受 sourceTotalUs 约束", () => {
		const d1 = trimSegment(withSource, "a", "end", 10 * SEC);
		expect(d1.tracks[0].segments.find((s) => s.id === "a")!.targetDurationUs).toBe(3 * SEC); // 钳到 b 左缘 5s
		const d2 = trimSegment(withSource, "b", "end", 10 * SEC, { sourceTotalUs: 3 * SEC });
		const b = d2.tracks[0].segments.find((s) => s.id === "b")!;
		expect(b.targetDurationUs).toBe(3 * SEC); // source 还剩 1s 余量
		expect(b.sourceDurationUs).toBe(3 * SEC);
	});

	it("收缩下限 MIN_SEGMENT_US；钳位后 delta=0 或未命中返回原引用", () => {
		const d = trimSegment(withSource, "b", "end", -10 * SEC);
		expect(d.tracks[0].segments.find((s) => s.id === "b")!.targetDurationUs).toBe(MIN_SEGMENT_US);
		expect(trimSegment(withSource, "a", "start", -0)).toBe(withSource);
		expect(trimSegment(withSource, "nope", "end", SEC)).toBe(withSource);
	});

	it("speed=2 时 source 窗口按 2 倍联动", () => {
		const d0 = doc({
			id: "t1",
			segments: [seg("a", 0, 2 * SEC, { sourceStartUs: 0, sourceDurationUs: 4 * SEC, speed: 2 })],
		});
		const d = trimSegment(d0, "a", "end", -1 * SEC);
		const a = d.tracks[0].segments[0];
		expect(a.targetDurationUs).toBe(1 * SEC);
		expect(a.sourceDurationUs).toBe(2 * SEC);
	});
});

describe("rtcOps splitSegment", () => {
	it("两段引用同一 assetId、source 窗口相邻互补", () => {
		const d0 = doc({
			id: "t1",
			segments: [seg("a", 1 * SEC, 4 * SEC, { assetId: "V001", sourceStartUs: 2 * SEC, sourceDurationUs: 4 * SEC })],
		});
		const d = splitSegment(d0, "a", 2 * SEC);
		const [l, r] = d.tracks[0].segments;
		expect(d.tracks[0].segments).toHaveLength(2);
		expect(l.assetId).toBe("V001");
		expect(r.assetId).toBe("V001"); // 绝不产生新素材实体
		expect(l.targetDurationUs).toBe(1 * SEC);
		expect(r.targetStartUs).toBe(2 * SEC);
		expect(r.targetDurationUs).toBe(3 * SEC);
		expect(l.sourceStartUs).toBe(2 * SEC);
		expect(l.sourceDurationUs).toBe(1 * SEC);
		expect(r.sourceStartUs).toBe(3 * SEC);
		expect(r.sourceDurationUs).toBe(3 * SEC);
	});

	it("切点在边界/距边界不足 MIN_SEGMENT_US → 原引用 no-op", () => {
		const d0 = doc({ id: "t1", segments: [seg("a", 0, 2 * SEC)] });
		expect(splitSegment(d0, "a", 0)).toBe(d0);
		expect(splitSegment(d0, "a", 2 * SEC)).toBe(d0);
		expect(splitSegment(d0, "a", 2 * SEC - 100)).toBe(d0);
	});
});

describe("rtcOps replaceSegmentMedia（素材拖到片段上=原位替换）", () => {
	const base = doc({
		id: "t1",
		segments: [
			seg("a", 2 * SEC, 4 * SEC, {
				assetId: "V001",
				uri: "old.mp4",
				name: "旧素材",
				sourceStartUs: 1 * SEC,
				sourceDurationUs: 4 * SEC,
				shotRef: { episodeId: "ep1", shotId: "s1" },
				status: "running",
				progress: 42,
				taskRef: "task-1",
			}),
			seg("b", 8 * SEC, 2 * SEC),
		],
	});

	it("位置不动、时长保持；素材/名称换新、source 归零、占位状态清空", () => {
		const d = replaceSegmentMedia(base, "a", {
			media: "video",
			assetId: "V777",
			uri: "new.mp4",
			name: "新素材",
			sourceTotalUs: 30 * SEC,
		});
		const a = d.tracks[0].segments.find((s) => s.id === "a")!;
		expect(a.targetStartUs).toBe(2 * SEC); // 不挪位
		expect(a.targetDurationUs).toBe(4 * SEC); // 原时长保持
		expect(a.kind).toBe("media");
		expect(a.assetId).toBe("V777");
		expect(a.uri).toBe("new.mp4");
		expect(a.name).toBe("新素材");
		expect(a.sourceStartUs).toBe(0);
		expect(a.sourceDurationUs).toBe(4 * SEC);
		expect(a.shotRef).toEqual({ episodeId: "ep1", shotId: "s1" }); // 分镜关联保留
		expect(a.status).toBeUndefined();
		expect(a.progress).toBeUndefined();
		expect(a.taskRef).toBeUndefined();
		expect(d.tracks[0].segments).toHaveLength(2); // 不增不删片段
	});

	it("新素材撑不满原时长 → 收到素材可用长度（只会变短，绝不与后一片段重叠）", () => {
		const d = replaceSegmentMedia(base, "a", { media: "video", assetId: "V2", uri: "s.mp4", sourceTotalUs: 1_500_000 });
		const a = d.tracks[0].segments.find((s) => s.id === "a")!;
		expect(a.targetDurationUs).toBe(1_500_000);
		expect(a.sourceDurationUs).toBe(1_500_000);
		expect(a.targetStartUs).toBe(2 * SEC);
	});

	it("变速片段按 speed 换算；真实时长未知则不建 source 窗口；图片不建窗口且时长原样", () => {
		const sp = doc({ id: "t1", segments: [seg("a", 0, 2 * SEC, { speed: 2, sourceStartUs: 0, sourceDurationUs: 4 * SEC })] });
		const d1 = replaceSegmentMedia(sp, "a", { media: "video", assetId: "V2", sourceTotalUs: 2 * SEC });
		const a1 = d1.tracks[0].segments[0];
		expect(a1.targetDurationUs).toBe(1 * SEC); // 2s 素材按 2 倍速只够放 1s
		expect(a1.sourceDurationUs).toBe(2 * SEC);

		const d2 = replaceSegmentMedia(base, "a", { media: "video", assetId: "V2" }); // 探测失败
		const a2 = d2.tracks[0].segments.find((s) => s.id === "a")!;
		expect(a2.sourceStartUs).toBeUndefined();
		expect(a2.sourceDurationUs).toBeUndefined();

		const d3 = replaceSegmentMedia(base, "a", { media: "image", assetId: "IMG1", sourceTotalUs: 100 });
		const a3 = d3.tracks[0].segments.find((s) => s.id === "a")!;
		expect(a3.targetDurationUs).toBe(4 * SEC); // 图片可任意拉伸，时长不动
		expect(a3.sourceStartUs).toBeUndefined();
	});

	it("新素材无 assetId → 清掉旧 assetId（防导出按旧素材去重）；片段未找到返回原引用", () => {
		const d = replaceSegmentMedia(base, "a", { media: "video", uri: "x.mp4" });
		expect(d.tracks[0].segments.find((s) => s.id === "a")!.assetId).toBeUndefined();
		expect(replaceSegmentMedia(base, "nope", { media: "video" })).toBe(base);
	});
});

describe("rtcOps removeSegments / docDurationUs / snapCandidates", () => {
	it("removeSegments 跨轨批量删；全都没删到返回原引用", () => {
		const d0 = doc({ id: "t1", segments: [seg("a", 0, SEC)] }, { id: "t2", segments: [seg("x", 0, SEC)] });
		const d = removeSegments(d0, ["a", "x"]);
		expect(d.tracks[0].segments).toHaveLength(0);
		expect(d.tracks[1].segments).toHaveLength(0);
		expect(removeSegments(d0, ["nope"])).toBe(d0);
	});

	it("docDurationUs=最大右缘；空文档 0", () => {
		expect(docDurationUs(doc({ id: "t1", segments: [] }))).toBe(0);
		expect(docDurationUs(doc({ id: "t1", segments: [seg("a", 2 * SEC, 3 * SEC)] }))).toBe(5 * SEC);
	});

	it("snapCandidates 含片段边界+整秒刻度、升序去重、排除 excludeIds", () => {
		const d0 = doc({ id: "t1", segments: [seg("a", 500_000, SEC), seg("b", 3 * SEC, SEC)] });
		const cands = snapCandidates(d0, ["b"]);
		expect(cands).toContain(500_000);
		expect(cands).toContain(1_500_000);
		expect(cands).not.toContain(4 * SEC); // b 的右缘被排除（4s 超出剩余 maxEnd=1.5s 的整秒覆盖）
		expect(cands).toContain(0);
		expect(cands).toContain(2 * SEC); // 1.5s 的下一整秒
		const sorted = [...cands].sort((x, y) => x - y);
		expect(cands).toEqual(sorted);
		expect(new Set(cands).size).toBe(cands.length);
	});
});

describe("rtcOps 时间轴 UI 纯函数", () => {
	it("nearestSnap：阈值内取最近、阈值外 null、空数组 null", () => {
		const cands = [0, SEC, 2 * SEC, 5 * SEC];
		expect(nearestSnap(cands, SEC + 100, 200)).toBe(SEC);
		expect(nearestSnap(cands, 1_600_000, 500_000)).toBe(2 * SEC);
		expect(nearestSnap(cands, 3_500_000, 200_000)).toBeNull();
		expect(nearestSnap([], SEC, SEC)).toBeNull();
		expect(nearestSnap(cands, -100, 200)).toBe(0);
		expect(nearestSnap(cands, 10 * SEC, 100)).toBeNull();
	});

	it("snapSegmentStart：首缘/尾缘各自吸附取更近者，均无命中原样返回", () => {
		const cands = [0, 5 * SEC];
		// 尾缘 3.9s 距 5s 太远；首缘 -0.1s 距 0 近 → 吸到 0
		expect(snapSegmentStart(cands, -100_000, 4 * SEC, 200_000)).toBe(0);
		// 尾缘 4.9s 距 5s 仅 0.1s，比首缘 0.9s 近 → 吸尾缘（start=1s）
		expect(snapSegmentStart(cands, 900_000, 4 * SEC, 200_000)).toBe(1 * SEC);
		expect(snapSegmentStart(cands, 2 * SEC, SEC, 100_000)).toBe(2 * SEC);
	});

	it("rulerStepUs 随缩放取 1s/5s/10s/30s/1m 档", () => {
		expect(rulerStepUs(100)).toBe(1 * SEC);
		expect(rulerStepUs(20)).toBe(5 * SEC);
		expect(rulerStepUs(10)).toBe(10 * SEC);
		expect(rulerStepUs(3)).toBe(30 * SEC);
		expect(rulerStepUs(1.2)).toBe(60 * SEC);
		expect(rulerStepUs(0.1)).toBe(60 * SEC); // 兜底最大档
	});

	it("formatTimecode HH:MM:SS.ff（帧号按 fps，夹在 0..fps-1）", () => {
		expect(formatTimecode(0)).toBe("00:00:00.00");
		expect(formatTimecode(1_500_000, 30)).toBe("00:00:01.15");
		expect(formatTimecode(3661_000_000, 30)).toBe("01:01:01.00");
		expect(formatTimecode(999_999, 30)).toBe("00:00:00.29"); // 末尾浮点不溢出成 30 帧
		expect(formatTimecode(500_000, 0)).toBe("00:00:00.15"); // 非法 fps 回退 30
		expect(formatTimecode(-100)).toBe("00:00:00.00");
	});

	it("trackTypeForMedia：图片/视频→video 轨、音频→audio 轨", () => {
		expect(trackTypeForMedia("image")).toBe("video");
		expect(trackTypeForMedia("video")).toBe("video");
		expect(trackTypeForMedia("audio")).toBe("audio");
	});
});

describe("rtcOps rippleDeleteSegments（波纹删除）", () => {
	it("同轨右侧片段左移「被删总时长」，原有空隙保留", () => {
		// A[0,2) 空[2,3) B[3,5) C[6,8)
		const d = doc({ id: "t1", segments: [seg("a", 0, 2 * SEC), seg("b", 3 * SEC, 2 * SEC), seg("c", 6 * SEC, 2 * SEC)] });
		const r = rippleDeleteSegments(d, ["a"]);
		expect(r.tracks[0].segments.map((s) => [s.id, s.targetStartUs / SEC])).toEqual([
			["b", 1], // 3 - 2
			["c", 4], // 6 - 2（B/C 之间的 1 秒空隙原样保留）
		]);
	});

	it("多选删除：各 survivor 按其左侧被删总时长左移，绝不重叠、绝不越过 0", () => {
		const d = doc({
			id: "t1",
			segments: [seg("a", 0, 2 * SEC), seg("b", 2 * SEC, 2 * SEC), seg("c", 4 * SEC, 2 * SEC), seg("dd", 6 * SEC, 2 * SEC)],
		});
		const r = rippleDeleteSegments(d, ["a", "c"]);
		const segs = r.tracks[0].segments;
		expect(segs.map((s) => [s.id, s.targetStartUs / SEC, s.targetDurationUs / SEC])).toEqual([
			["b", 0, 2], // 左侧删了 a（2s）
			["dd", 2, 2], // 左侧删了 a+c（4s）
		]);
		expect(segs[0].targetStartUs + segs[0].targetDurationUs).toBeLessThanOrEqual(segs[1].targetStartUs);
	});

	it("⚠ 只影响被删片段所在轨道，其它轨道原样（引用都不变）", () => {
		const d = doc(
			{ id: "t1", segments: [seg("a", 0, 2 * SEC), seg("b", 2 * SEC, 2 * SEC)] },
			{ id: "t2", type: "audio", segments: [seg("m", 0, 6 * SEC, { media: "audio" })] },
		);
		const r = rippleDeleteSegments(d, ["a"]);
		expect(r.tracks[1]).toBe(d.tracks[1]); // 音频轨原引用
		expect(r.tracks[0].segments.map((s) => s.targetStartUs)).toEqual([0]);
	});

	it("一个都没删到返回原 doc 引用", () => {
		const d = doc({ id: "t1", segments: [seg("a", 0, SEC)] });
		expect(rippleDeleteSegments(d, ["nope"])).toBe(d);
		expect(rippleDeleteSegments(d, [])).toBe(d);
	});
});

describe("rtcOps pasteSegments（粘贴落位）", () => {
	const entry = (id: string, offsetUs: number, trackId?: string, type: "video" | "audio" = "video") => ({
		seg: seg(id, 0, 2 * SEC, type === "audio" ? { media: "audio" as const } : {}),
		trackId,
		trackType: type,
		offsetUs,
	});

	it("落在锚点 + 各自偏移：整批的相对时间关系原样保持", () => {
		const d = doc({ id: "t1", segments: [] });
		const r = pasteSegments(d, [entry("n1", 0, "t1"), entry("n2", 5 * SEC, "t1")], 10 * SEC);
		expect(r.tracks[0].segments.map((s) => [s.id, s.targetStartUs / SEC])).toEqual([
			["n1", 10],
			["n2", 15], // 相对间距 5s 保持
		]);
	});

	it("原轨仍在 → 落回原轨；落点被占则夹到最近空隙（不推挤既有片段）", () => {
		const d = doc(
			{ id: "t1", segments: [seg("old", 10 * SEC, 2 * SEC)] },
			{ id: "t2", segments: [] },
		);
		const r = pasteSegments(d, [entry("n1", 0, "t2")], 10 * SEC);
		expect(r.tracks[1].segments.map((s) => s.id)).toEqual(["n1"]); // 落回 t2
		const r2 = pasteSegments(d, [entry("n1", 0, "t1")], 10 * SEC);
		expect(r2.tracks[0].segments.map((s) => [s.id, s.targetStartUs / SEC])).toEqual([
			["n1", 8], // 10s 被 old 占住 → 夹到最近空隙（8–10）
			["old", 10],
		]);
	});

	it("原轨不在/类型不符/已锁 → 首条同类型未锁轨；都没有则新建一条同类型轨", () => {
		const locked: RtcDoc = {
			...doc({ id: "t1", segments: [] }),
			tracks: [{ id: "t1", type: "video", locked: true, segments: [] }],
		};
		const r = pasteSegments(locked, [entry("n1", 0, "t1")], 0);
		expect(r.tracks).toHaveLength(2); // 唯一的视频轨锁了 → 新建
		expect(r.tracks[1].type).toBe("video");
		expect(r.tracks[1].segments.map((s) => s.id)).toEqual(["n1"]);

		const noAudio = doc({ id: "t1", segments: [] });
		const r2 = pasteSegments(noAudio, [entry("a1", 0, "gone", "audio")], 0);
		expect(r2.tracks.map((t) => t.type)).toEqual(["video", "audio"]); // 音频轨新建在视频轨之后
		expect(r2.tracks[1].segments.map((s) => s.id)).toEqual(["a1"]);
	});

	it("同批多条落同一轨不会互相重叠；空清单返回原引用", () => {
		const d = doc({ id: "t1", segments: [] });
		const r = pasteSegments(d, [entry("n1", 0, "t1"), entry("n2", SEC, "t1")], 0);
		const segs = r.tracks[0].segments;
		expect(segs).toHaveLength(2);
		expect(segs[0].targetStartUs + segs[0].targetDurationUs).toBeLessThanOrEqual(segs[1].targetStartUs);
		expect(pasteSegments(d, [], 0)).toBe(d);
	});
});

describe("rtcOps 走带与时间输入", () => {
	it("frameDurationUs：按 fps 算一帧；非法 fps 回退 30", () => {
		expect(frameDurationUs(30)).toBe(33333);
		expect(frameDurationUs(25)).toBe(40000);
		expect(frameDurationUs(0)).toBe(33333);
		expect(frameDurationUs(NaN)).toBe(33333);
	});

	it("stepPlayheadUs：钳在 [0, 时长]", () => {
		expect(stepPlayheadUs(SEC, 33333, 10 * SEC)).toBe(SEC + 33333);
		expect(stepPlayheadUs(0, -33333, 10 * SEC)).toBe(0);
		expect(stepPlayheadUs(10 * SEC, SEC, 10 * SEC)).toBe(10 * SEC);
		expect(stepPlayheadUs(5 * SEC, SEC, 0)).toBe(0); // 空文档恒 0
	});

	it("parseTimecodeInput：秒数与时间码两种形态；小数按十进制秒", () => {
		expect(parseTimecodeInput("6")).toBe(6 * SEC);
		expect(parseTimecodeInput("6.3")).toBe(6.3 * SEC);
		expect(parseTimecodeInput(" 6.3s ")).toBe(6.3 * SEC);
		expect(parseTimecodeInput("6.3秒")).toBe(6.3 * SEC);
		expect(parseTimecodeInput("0:06.3")).toBe(6.3 * SEC);
		expect(parseTimecodeInput("1:02:03.5")).toBe((3600 + 120 + 3.5) * SEC);
		expect(parseTimecodeInput("0：06.3")).toBe(6.3 * SEC); // 全角冒号
		expect(parseTimecodeInput(".5")).toBe(0.5 * SEC);
	});

	it("parseTimecodeInput：非法输入一律 null（调用方回退原值）", () => {
		expect(parseTimecodeInput("")).toBeNull();
		expect(parseTimecodeInput("  ")).toBeNull();
		expect(parseTimecodeInput("abc")).toBeNull();
		expect(parseTimecodeInput("-3")).toBeNull();
		expect(parseTimecodeInput("1:2:3:4")).toBeNull(); // 超过 3 段
		expect(parseTimecodeInput("1.5:03")).toBeNull(); // 非末位带小数
		expect(parseTimecodeInput("6..3")).toBeNull();
	});

	it("formatEditableTime ↔ parseTimecodeInput 原样往返", () => {
		expect(formatEditableTime(6_300_000)).toBe("0:06.30");
		expect(formatEditableTime(3_723_500_000)).toBe("1:02:03.50");
		expect(formatEditableTime(-5)).toBe("0:00.00");
		for (const us of [0, 6_300_000, 65_120_000, 3_723_500_000]) {
			expect(parseTimecodeInput(formatEditableTime(us))).toBe(us);
		}
	});
});

describe("pruneScriptTracks（补充10：原文改派生只读——旧形态 role:\"script\" 轨加载即清）", () => {
	it("含旧原文轨：整轨剔除、其余轨原样；不含：返回原引用零开销", () => {
		const legacy: RtcDoc = {
			id: "d", name: "d", fps: 30,
			tracks: [
				{ id: "tx", type: "text", role: "script", segments: [
					{ id: "o1", kind: "media", name: "原文", text: { content: "第一镜原文" }, targetStartUs: 0, targetDurationUs: 4_000_000 } as RtcSegment,
				] },
				{ id: "tv", type: "video", segments: [] },
			],
		} as RtcDoc;
		const pruned = pruneScriptTracks(legacy);
		expect(pruned.tracks.map((t) => t.id)).toEqual(["tv"]);
		const clean: RtcDoc = { id: "d2", name: "d2", fps: 30, tracks: [{ id: "tv", type: "video", segments: [] }] } as RtcDoc;
		expect(pruneScriptTracks(clean)).toBe(clean);
	});
});

describe("rtcOps setSegmentSpeed 变速联动时长", () => {
	it("10s 源 speed 1→2：targetDur 变 5s，source 窗口原样（不变量 sourceDur = targetDur×speed）", () => {
		const d = doc({
			id: "t1",
			segments: [seg("a", 2 * SEC, 10 * SEC, { sourceStartUs: 1 * SEC, sourceDurationUs: 10 * SEC })],
		});
		const d2 = setSegmentSpeed(d, "a", 2);
		const a = d2.tracks[0].segments[0];
		expect(a.speed).toBe(2);
		expect(a.targetStartUs).toBe(2 * SEC); // 起点不动
		expect(a.targetDurationUs).toBe(5 * SEC);
		expect(a.sourceStartUs).toBe(1 * SEC); // 源窗口起点不动
		expect(a.sourceDurationUs).toBe(10 * SEC); // round(5s×2)=10s 精确回写
	});

	it("减速被后方片段挡道：targetDur 钳到空隙，sourceDurationUs 回写 targetDur×speed 维持不变量", () => {
		const d = doc({
			id: "t1",
			segments: [
				seg("a", 0, 5 * SEC, { sourceStartUs: 0, sourceDurationUs: 10 * SEC, speed: 2 }),
				seg("b", 7 * SEC, 2 * SEC),
			],
		});
		const d2 = setSegmentSpeed(d, "a", 1); // 期望 10s，被 b 的左缘钳到 7s
		const a = d2.tracks[0].segments[0];
		expect("speed" in a).toBe(false); // speed=1 默认值不落键
		expect(a.targetDurationUs).toBe(7 * SEC);
		expect(a.sourceStartUs).toBe(0); // 起点不动——尾部源内容暂不展示，之后 trim 右缘可拉回
		expect(a.sourceDurationUs).toBe(7 * SEC); // 钳位后回写 7s×1
	});

	it("时长下限 MIN_SEGMENT_US：极短源加速到底也不出零长片段", () => {
		const d = doc({
			id: "t1",
			segments: [seg("a", 0, 6000, { sourceStartUs: 0, sourceDurationUs: 3000, speed: 0.5 })],
		});
		const d2 = setSegmentSpeed(d, "a", 5); // raw=round(3000/5)=600 < MIN
		const a = d2.tracks[0].segments[0];
		expect(a.targetDurationUs).toBe(MIN_SEGMENT_US);
		expect(a.sourceDurationUs).toBe(MIN_SEGMENT_US * 5); // 回写维持不变量
	});

	it("无 source 窗口（图片等）：targetDur 按 oldSpeed/newSpeed 等比缩放 + 右缘空隙钳位", () => {
		const d = doc({
			id: "t1",
			segments: [seg("img", 0, 3 * SEC, { media: "image" }), seg("b", 10 * SEC, SEC)],
		});
		const d2 = setSegmentSpeed(d, "img", 2); // 3s×(1/2)=1.5s
		expect(d2.tracks[0].segments[0].targetDurationUs).toBe(1_500_000);
		const d3 = setSegmentSpeed(d2, "img", 0.2); // 1.5s×(2/0.2)=15s → 被 b 钳到 10s
		expect(d3.tracks[0].segments[0].targetDurationUs).toBe(10 * SEC);
		expect(d3.tracks[0].segments[0].speed).toBe(0.2);
	});

	it("同值 no-op 返回原引用（含夹取后同值：99→夹到 5 == 现值 5）", () => {
		const d = doc({
			id: "t1",
			segments: [seg("a", 0, 5 * SEC, { sourceStartUs: 0, sourceDurationUs: 10 * SEC, speed: 2 })],
		});
		expect(setSegmentSpeed(d, "a", 2)).toBe(d);
		const d5 = setSegmentSpeed(d, "a", 5);
		expect(setSegmentSpeed(d5, "a", 99)).toBe(d5); // 夹到 5 与现值相同
		const clean = doc({ id: "t1", segments: [seg("a", 0, 5 * SEC)] });
		expect(setSegmentSpeed(clean, "a", 1)).toBe(clean); // 缺省 speed=1 同值
	});

	it("非 media（placeholder/compound）与不存在的片段 → 原引用 no-op", () => {
		const d = doc({
			id: "t1",
			segments: [
				seg("p", 0, 2 * SEC, { kind: "placeholder" }),
				seg("c", 3 * SEC, 2 * SEC, { kind: "compound", sourceStartUs: 0, sourceDurationUs: 2 * SEC }),
			],
		});
		expect(setSegmentSpeed(d, "p", 2)).toBe(d);
		expect(setSegmentSpeed(d, "c", 2)).toBe(d);
		expect(setSegmentSpeed(d, "nope", 2)).toBe(d);
	});

	it("变速往返（2 再回 1）：时长与 source 窗口精确复原，speed 键摘除", () => {
		const d = doc({
			id: "t1",
			segments: [seg("a", 0, 10 * SEC, { sourceStartUs: 0, sourceDurationUs: 10 * SEC })],
		});
		const back = setSegmentSpeed(setSegmentSpeed(d, "a", 2), "a", 1);
		const a = back.tracks[0].segments[0];
		expect(a.targetDurationUs).toBe(10 * SEC);
		expect(a.sourceDurationUs).toBe(10 * SEC);
		expect("speed" in a).toBe(false);
	});
});
