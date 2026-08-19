/** 第二批：关键帧 → 剪映草稿 common_keyframes 的集成断言（值换算与 toJyClip 同一把尺）。 */
import { describe, it, expect } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { buildDraftContent, type JyAssetResolver, type JyResolvedAsset } from "./jianyingDraft";

function seg(p: Partial<RtcSegment>): RtcSegment {
	return {
		id: p.id || `seg-${Math.random().toString(36).slice(2, 8)}`,
		kind: p.kind ?? "media",
		targetStartUs: p.targetStartUs ?? 0,
		targetDurationUs: p.targetDurationUs ?? 4_000_000,
		...p,
	};
}

function track(type: RtcTrack["type"], segments: RtcSegment[]): RtcTrack {
	return { id: `track-${type}-${Math.random().toString(36).slice(2, 8)}`, type, segments };
}

function doc(tracks: RtcTrack[]): RtcDoc {
	return { id: "rtc-1", name: "测试剪辑", fps: 30, tracks };
}

const ASSETS: Record<string, JyResolvedAsset> = {
	V1: { absPath: "C:\\draft\\assets\\V1.mp4", durationUs: 10_000_000, width: 1280, height: 720, kind: "video" },
	AUD: { absPath: "C:\\draft\\assets\\AUD.mp3", durationUs: 30_000_000, kind: "audio" },
};
const resolve: JyAssetResolver = (id) => ASSETS[id];

type Json = Record<string, any>;
const segsOf = (r: { draftContent: Record<string, unknown> }, ti = 0) =>
	((r.draftContent as Json).tracks as Json[])[ti].segments as Json[];

describe("buildDraftContent · common_keyframes（第二批）", () => {
	it("无关键帧片段：common_keyframes 恒 []（存量草稿零变化）", () => {
		const r = buildDraftContent(doc([track("video", [seg({ assetId: "V1", sourceStartUs: 0, sourceDurationUs: 4_000_000 })])]), resolve);
		expect(segsOf(r)[0].common_keyframes).toEqual([]);
		expect(segsOf(r)[0].keyframe_refs).toEqual([]);
	});

	it("视觉片段：位置 x/y 换算（比例→半画幅 ×2、y 取负）+ property_type + pyJianYingDraft 字段同形", () => {
		const s = seg({
			assetId: "V1",
			sourceStartUs: 0,
			sourceDurationUs: 4_000_000,
			keyframes: {
				x: [{ t: 0, v: 0.25 }, { t: 4_000_000, v: -0.25 }],
				y: [{ t: 0, v: 0.1 }],
			},
		});
		const r = buildDraftContent(doc([track("video", [s])]), resolve);
		const lists = segsOf(r)[0].common_keyframes as Json[];
		const byProp = Object.fromEntries(lists.map((l) => [l.property_type as string, l]));
		const xs = byProp.KFTypePositionX.keyframe_list as Json[];
		expect(xs.map((k) => k.time_offset)).toEqual([0, 4_000_000]);
		expect(xs.map((k) => (k.values as number[])[0])).toEqual([0.5, -0.5]); // 0.25 → ×2
		const ys = byProp.KFTypePositionY.keyframe_list as Json[];
		expect((ys[0].values as number[])[0]).toBeCloseTo(-0.2); // y 取负（剪映 y 正向上）
		// 单帧字段同形（curveType/graphID/控制点/32 位 hex id）
		expect(xs[0].curveType).toBe("Line");
		expect(xs[0].graphID).toBe("");
		expect(xs[0].left_control).toEqual({ x: 0, y: 0 });
		expect(xs[0].right_control).toEqual({ x: 0, y: 0 });
		expect(String(xs[0].id)).toMatch(/^[0-9a-f]{32}$/);
		expect(byProp.KFTypePositionX.material_id).toBe("");
	});

	it("scale 帧 → KFTypeScaleX（等比单值）且 uniform_scale.on 不受影响（保持 true）", () => {
		const s = seg({
			assetId: "V1",
			sourceStartUs: 0,
			sourceDurationUs: 4_000_000,
			keyframes: { scale: [{ t: 0, v: 1 }, { t: 4_000_000, v: 2 }] },
		});
		const r = buildDraftContent(doc([track("video", [s])]), resolve);
		const sj = segsOf(r)[0];
		const lists = sj.common_keyframes as Json[];
		expect(lists).toHaveLength(1);
		expect(lists[0].property_type).toBe("KFTypeScaleX");
		expect((lists[0].keyframe_list as Json[]).map((k) => (k.values as number[])[0])).toEqual([1, 2]);
		expect((sj.uniform_scale as Json).on).toBe(true); // pyJianYingDraft：uniform_scale 关键帧不解锁等比
	});

	it("音频片段：只导 volume（KFTypeVolume），画面属性帧被忽略", () => {
		const s = seg({
			assetId: "AUD",
			media: "audio",
			sourceStartUs: 0,
			sourceDurationUs: 4_000_000,
			keyframes: {
				volume: [{ t: 0, v: 1 }, { t: 4_000_000, v: 0 }],
				x: [{ t: 0, v: 0.5 }], // 音频无画面——不该出现在导出里
			},
		});
		const r = buildDraftContent(doc([track("audio", [s])]), resolve);
		const lists = segsOf(r)[0].common_keyframes as Json[];
		expect(lists).toHaveLength(1);
		expect(lists[0].property_type).toBe("KFTypeVolume");
		expect((lists[0].keyframe_list as Json[]).map((k) => (k.values as number[])[0])).toEqual([1, 0]);
	});
});
