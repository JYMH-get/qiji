/**
 * 第238轮（批次1）新增 rtcOps 纯函数的单测：
 * 批量分割 / 播放头两侧选择 / 裁剪到播放头 / 分割点导航 / 组合。
 * （独立文件，不与其它并行批次共享 rtcOps.test.ts，防合并冲突。）
 */
import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import {
	cutPoints,
	expandSelectionWithGroups,
	groupSegments,
	nextCutPoint,
	segmentIdsSideOf,
	splitAllAtPlayhead,
	trimSegmentToPlayhead,
	ungroupSegments,
} from "./rtcOps";

const SEC = 1_000_000;

function seg(id: string, startSec: number, durSec: number, extra?: Partial<RtcSegment>): RtcSegment {
	return {
		id,
		kind: "media",
		media: "video",
		targetStartUs: startSec * SEC,
		targetDurationUs: durSec * SEC,
		sourceStartUs: 0,
		sourceDurationUs: durSec * SEC,
		...extra,
	};
}

function track(id: string, segments: RtcSegment[], extra?: Partial<RtcTrack>): RtcTrack {
	return { id, type: "video", segments, ...extra };
}

function doc(tracks: RtcTrack[]): RtcDoc {
	return { id: "d", name: "t", fps: 30, tracks };
}

function allSegs(d: RtcDoc): RtcSegment[] {
	return d.tracks.flatMap((t) => t.segments);
}

describe("splitAllAtPlayhead 批量分割", () => {
	it("全部未锁定轨道上跨过播放头的 media 片段各切一刀；素材实体绝不复制（assetId 共享、source 互补）", () => {
		const d0 = doc([
			track("t1", [seg("a", 0, 10, { assetId: "video001" })]),
			track("t2", [seg("b", 2, 4, { assetId: "video002" })]),
		]);
		const d1 = splitAllAtPlayhead(d0, 4 * SEC);
		expect(d1.tracks[0].segments).toHaveLength(2);
		expect(d1.tracks[1].segments).toHaveLength(2);
		const [a1, a2] = d1.tracks[0].segments;
		expect(a1.id).toBe("a"); // 左段保 id
		expect(a2.assetId).toBe("video001"); // 同素材引用
		expect(a1.targetDurationUs).toBe(4 * SEC);
		expect(a2.targetStartUs).toBe(4 * SEC);
		// source 窗口相邻互补
		expect(a1.sourceDurationUs).toBe(4 * SEC);
		expect(a2.sourceStartUs).toBe(4 * SEC);
		expect(a2.sourceDurationUs).toBe(6 * SEC);
	});

	it("锁定轨道跳过；占位片段不切；无人跨过播放头=原 doc 引用", () => {
		const d0 = doc([
			track("locked", [seg("a", 0, 10)], { locked: true }),
			track("ph", [seg("p", 0, 10, { kind: "placeholder" })]),
		]);
		expect(splitAllAtPlayhead(d0, 5 * SEC)).toBe(d0);
		// 播放头在所有片段之外
		const d1 = doc([track("t", [seg("x", 0, 3)])]);
		expect(splitAllAtPlayhead(d1, 8 * SEC)).toBe(d1);
	});

	it("贴边（距边不足最小片段时长）no-op", () => {
		const d0 = doc([track("t", [seg("a", 0, 5)])]);
		expect(splitAllAtPlayhead(d0, 0)).toBe(d0);
		expect(splitAllAtPlayhead(d0, 5 * SEC)).toBe(d0);
	});
});

describe("segmentIdsSideOf 播放头两侧选择", () => {
	const d = doc([
		track("t1", [seg("a", 0, 2), seg("b", 3, 2), seg("c", 6, 2)]),
		track("t2", [seg("x", 1, 6)], { locked: true }), // 锁轨跳过
		track("t3", [seg("y", 4, 4)]),
	]);

	it("left=起点早于播放头；right=终点晚于播放头；跨过播放头的片段两侧都算", () => {
		expect(segmentIdsSideOf(d, 5.5 * SEC, "left")).toEqual(["a", "b", "y"]);
		expect(segmentIdsSideOf(d, 5.5 * SEC, "right")).toEqual(["c", "y"]); // y(4-8s) 跨过 5.5s：两侧都算
	});

	it("边界严格：起点/终点恰在播放头上不算对应侧", () => {
		// y 起点=4s：left(4s) 不含 y；b 终点=5s：right(5s) 不含 b
		expect(segmentIdsSideOf(d, 4 * SEC, "left")).toEqual(["a", "b"]);
		expect(segmentIdsSideOf(d, 5 * SEC, "right")).toEqual(["c", "y"]);
	});

	it("锁定轨道的片段不入选", () => {
		expect(segmentIdsSideOf(d, 10 * SEC, "left")).not.toContain("x");
	});
});

describe("trimSegmentToPlayhead 裁剪到播放头", () => {
	it("左缘裁到播放头（保留右半）：source 窗口按 speed 联动", () => {
		const d0 = doc([track("t", [seg("a", 2, 8)])]);
		const d1 = trimSegmentToPlayhead(d0, "a", "start", 5 * SEC);
		const a = d1.tracks[0].segments[0];
		expect(a.targetStartUs).toBe(5 * SEC);
		expect(a.targetDurationUs).toBe(5 * SEC);
		expect(a.sourceStartUs).toBe(3 * SEC); // 左缘右收 3s → 源窗口起点同步右移
	});

	it("右缘裁到播放头（保留左半）", () => {
		const d0 = doc([track("t", [seg("a", 2, 8)])]);
		const d1 = trimSegmentToPlayhead(d0, "a", "end", 6 * SEC);
		const a = d1.tracks[0].segments[0];
		expect(a.targetStartUs).toBe(2 * SEC);
		expect(a.targetDurationUs).toBe(4 * SEC);
		expect(a.sourceDurationUs).toBe(4 * SEC);
	});

	it("播放头在时间窗外 / 贴边 / 锁定轨道 / 片段不存在 → 原 doc 引用", () => {
		const d0 = doc([track("t", [seg("a", 2, 8)])]);
		expect(trimSegmentToPlayhead(d0, "a", "start", 1 * SEC)).toBe(d0); // 窗外
		expect(trimSegmentToPlayhead(d0, "a", "start", 2 * SEC)).toBe(d0); // 贴左边
		expect(trimSegmentToPlayhead(d0, "a", "end", 10 * SEC)).toBe(d0); // 贴右边
		expect(trimSegmentToPlayhead(d0, "nope", "start", 5 * SEC)).toBe(d0);
		const locked = doc([track("t", [seg("a", 2, 8)], { locked: true })]);
		expect(trimSegmentToPlayhead(locked, "a", "start", 5 * SEC)).toBe(locked);
	});
});

describe("cutPoints / nextCutPoint 分割点导航", () => {
	const d = doc([
		track("t1", [seg("a", 1, 2), seg("b", 3, 2)]), // 边界 1,3 / 3,5（3 去重）
		track("t2", [seg("y", 2, 4)]), // 边界 2,6
	]);

	it("剪辑点=0 + 全部片段首尾边界，升序去重；⚠ 不含整秒刻度（与磁吸候选刻意不同）", () => {
		expect(cutPoints(d)).toEqual([0, 1 * SEC, 2 * SEC, 3 * SEC, 5 * SEC, 6 * SEC]);
	});

	it("上一/下一分割点严格相邻；两端返回 null", () => {
		const pts = cutPoints(d);
		expect(nextCutPoint(pts, 3 * SEC, 1)).toBe(5 * SEC);
		expect(nextCutPoint(pts, 3 * SEC, -1)).toBe(2 * SEC);
		expect(nextCutPoint(pts, 3.5 * SEC, -1)).toBe(3 * SEC);
		expect(nextCutPoint(pts, 6 * SEC, 1)).toBeNull();
		expect(nextCutPoint(pts, 0, -1)).toBeNull();
	});
});

describe("groupSegments / ungroupSegments / expandSelectionWithGroups 组合", () => {
	it("跨轨分配同一 groupId；已在别的组的片段改投新组", () => {
		const d0 = doc([
			track("t1", [seg("a", 0, 2, { groupId: "old" }), seg("b", 3, 2)]),
			track("t2", [seg("y", 1, 2)]),
		]);
		const d1 = groupSegments(d0, ["a", "y"], "g1");
		const byId = Object.fromEntries(allSegs(d1).map((s) => [s.id, s]));
		expect(byId.a.groupId).toBe("g1");
		expect(byId.y.groupId).toBe("g1");
		expect(byId.b.groupId).toBeUndefined();
	});

	it("命中不足 2 个片段 no-op；缺省 groupId 自动分配且两片段一致", () => {
		const d0 = doc([track("t", [seg("a", 0, 2), seg("b", 3, 2)])]);
		expect(groupSegments(d0, ["a"])).toBe(d0);
		expect(groupSegments(d0, ["nope", "x"])).toBe(d0);
		const d1 = groupSegments(d0, ["a", "b"]);
		const [a, b] = d1.tracks[0].segments;
		expect(a.groupId).toBeTruthy();
		expect(a.groupId).toBe(b.groupId);
	});

	it("解组按整组解散（选中里带一个成员即整组去 groupId 字段）；无组可解 no-op", () => {
		const d0 = groupSegments(
			doc([track("t", [seg("a", 0, 2), seg("b", 3, 2), seg("c", 6, 2)])]),
			["a", "b"],
			"g1",
		);
		const d1 = ungroupSegments(d0, ["a"]);
		for (const s of allSegs(d1)) expect("groupId" in s).toBe(false);
		expect(ungroupSegments(d1, ["a", "c"])).toBe(d1);
	});

	it("选区按组扩张：补齐同组成员；无组时返回原数组引用", () => {
		const d0 = groupSegments(
			doc([track("t1", [seg("a", 0, 2), seg("b", 3, 2)]), track("t2", [seg("y", 1, 2)])]),
			["a", "y"],
			"g1",
		);
		expect(expandSelectionWithGroups(d0, ["a"]).sort()).toEqual(["a", "y"]);
		expect(expandSelectionWithGroups(d0, ["a", "b"]).sort()).toEqual(["a", "b", "y"]);
		const ids = ["b"];
		expect(expandSelectionWithGroups(d0, ids)).toBe(ids); // b 无组：原引用
	});
});
