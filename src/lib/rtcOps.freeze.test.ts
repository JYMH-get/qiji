import { describe, it, expect } from "vitest";
import type { RtcDoc, RtcKeyframe, RtcSegment, RtcTrack } from "@/types/rtc";
import { FREEZE_DEFAULT_US, MIN_SEGMENT_US, insertFreezeFrame } from "./rtcOps";

// ── 造数据 ──────────────────────────────────────────────

function seg(p: Partial<RtcSegment>): RtcSegment {
	return {
		id: p.id || `seg-${Math.random().toString(36).slice(2, 8)}`,
		kind: p.kind ?? "media",
		media: p.media ?? "video",
		targetStartUs: p.targetStartUs ?? 0,
		targetDurationUs: p.targetDurationUs ?? 10_000_000,
		...p,
	};
}

function docOf(segments: RtcSegment[], extra?: Partial<RtcTrack>): RtcDoc {
	const track: RtcTrack = { id: "t1", type: "video", segments, ...extra };
	return { id: "rtc", name: "测试", fps: 30, tracks: [track] };
}

const kf = (t: number, v: number): RtcKeyframe => ({ t, v });
const STILL = { id: "still-1", assetId: "IMG-1", uri: "asset://still.png", name: "定格-片段" };

describe("insertFreezeFrame · 分割 + 插入 + 右移", () => {
	it("原片段切两半、中间插 3 秒图片片段、时序正确", () => {
		const d0 = docOf([
			seg({ id: "v", assetId: "V1", uri: "asset://v.mp4", targetStartUs: 0, targetDurationUs: 10_000_000, sourceStartUs: 0, sourceDurationUs: 10_000_000 }),
		]);
		const d1 = insertFreezeFrame(d0, "v", 4_000_000, STILL);
		const segs = d1.tracks[0].segments;
		expect(segs).toHaveLength(3);
		const [left, still, right] = segs;
		// 左半：原 id、[0, 4s)
		expect(left.id).toBe("v");
		expect(left.targetStartUs).toBe(0);
		expect(left.targetDurationUs).toBe(4_000_000);
		// 定格：图片、3 秒、指定 id/资产
		expect(still.id).toBe("still-1");
		expect(still.kind).toBe("media");
		expect(still.media).toBe("image");
		expect(still.assetId).toBe("IMG-1");
		expect(still.targetStartUs).toBe(4_000_000);
		expect(still.targetDurationUs).toBe(FREEZE_DEFAULT_US);
		// 右半：右移 3 秒、时长=剩余 6 秒
		expect(right.targetStartUs).toBe(4_000_000 + FREEZE_DEFAULT_US);
		expect(right.targetDurationUs).toBe(6_000_000);
	});

	it("⚠ 素材唯一性：两半共享同一 assetId、source 窗口相邻互补；定格是另一个素材（有自己的 assetId）", () => {
		const d0 = docOf([
			seg({ id: "v", assetId: "V1", uri: "asset://v.mp4", targetStartUs: 0, targetDurationUs: 10_000_000, sourceStartUs: 2_000_000, sourceDurationUs: 10_000_000 }),
		]);
		const [left, still, right] = insertFreezeFrame(d0, "v", 4_000_000, STILL).tracks[0].segments;
		expect(left.assetId).toBe("V1");
		expect(right.assetId).toBe("V1"); // 绝不复制素材
		expect(still.assetId).toBe("IMG-1"); // 抽帧产物是独立素材
		expect(left.sourceStartUs).toBe(2_000_000);
		expect(left.sourceDurationUs).toBe(4_000_000);
		expect(right.sourceStartUs).toBe(6_000_000); // 左末与右首在源素材上无缝相接
		expect(right.sourceDurationUs).toBe(6_000_000);
		// 定格图片无 source 窗口
		expect(still.sourceStartUs).toBeUndefined();
	});

	it("变速片段：source 偏移按 speed 换算", () => {
		const d0 = docOf([
			seg({ id: "v", assetId: "V1", speed: 2, targetStartUs: 0, targetDurationUs: 5_000_000, sourceStartUs: 0, sourceDurationUs: 10_000_000 }),
		]);
		const [left, , right] = insertFreezeFrame(d0, "v", 2_000_000, STILL).tracks[0].segments;
		expect(left.sourceDurationUs).toBe(4_000_000); // 2s × speed 2
		expect(right.sourceStartUs).toBe(4_000_000);
		expect(right.sourceDurationUs).toBe(6_000_000);
	});

	it("同轨右侧片段整体右移（片段间空隙原样保留）；插入后无重叠", () => {
		const d0 = docOf([
			seg({ id: "v", targetStartUs: 0, targetDurationUs: 4_000_000 }),
			seg({ id: "b", targetStartUs: 5_000_000, targetDurationUs: 2_000_000 }), // 与 v 之间 1s 空隙
		]);
		const d1 = insertFreezeFrame(d0, "v", 2_000_000, { ...STILL, durUs: 1_000_000 });
		const segs = d1.tracks[0].segments;
		expect(segs).toHaveLength(4);
		expect(segs[0].id).toBe("v");
		expect(segs[1].id).toBe("still-1");
		expect(segs[3].id).toBe("b");
		const b = segs.find((s) => s.id === "b")!;
		expect(b.targetStartUs).toBe(6_000_000); // 右移 1s，空隙仍是 1s
		// 全轨无重叠
		for (let i = 1; i < segs.length; i++) {
			expect(segs[i].targetStartUs).toBeGreaterThanOrEqual(segs[i - 1].targetStartUs + segs[i - 1].targetDurationUs);
		}
	});

	it("定格片段继承原片段 transform（画面无缝衔接），不继承关键帧", () => {
		const tf = { scaleX: 2, scaleY: 2, x: 0.1, y: 0, rotation: 0, opacity: 1 };
		const d0 = docOf([
			seg({ id: "v", targetStartUs: 0, targetDurationUs: 6_000_000, transform: tf, keyframes: { opacity: [kf(0, 1)] } }),
		]);
		const [, still] = insertFreezeFrame(d0, "v", 3_000_000, STILL).tracks[0].segments;
		expect(still.transform).toEqual(tf);
		expect(still.keyframes).toBeUndefined();
	});

	it("关键帧分账：左右两半各拿各的（右半 t 平移、跨切点补边界采样帧）", () => {
		const d0 = docOf([
			seg({ id: "v", targetStartUs: 0, targetDurationUs: 8_000_000, keyframes: { x: [kf(0, 0), kf(8_000_000, 0.8)] } }),
		]);
		const [left, , right] = insertFreezeFrame(d0, "v", 4_000_000, STILL).tracks[0].segments;
		expect(left.keyframes!.x).toEqual([kf(0, 0), kf(4_000_000, 0.4)]);
		expect(right.keyframes!.x).toEqual([kf(0, 0.4), kf(4_000_000, 0.8)]);
	});

	it("no-op：片段未找到 / 切点贴边（距两缘不足 MIN_SEGMENT_US）→ 返回原 doc 引用", () => {
		const d0 = docOf([seg({ id: "v", targetStartUs: 0, targetDurationUs: 5_000_000 })]);
		expect(insertFreezeFrame(d0, "missing", 2_000_000, STILL)).toBe(d0);
		expect(insertFreezeFrame(d0, "v", MIN_SEGMENT_US - 1, STILL)).toBe(d0);
		expect(insertFreezeFrame(d0, "v", 5_000_000 - MIN_SEGMENT_US + 1, STILL)).toBe(d0);
	});

	it("durUs 可定制且钳下限；缺省 3 秒", () => {
		const d0 = docOf([seg({ id: "v", targetStartUs: 0, targetDurationUs: 6_000_000 })]);
		const still = insertFreezeFrame(d0, "v", 3_000_000, { ...STILL, durUs: 10 }).tracks[0].segments[1];
		expect(still.targetDurationUs).toBe(MIN_SEGMENT_US);
	});
});
