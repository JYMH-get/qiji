import { describe, it, expect } from "vitest";
import type { RtcDoc, RtcSegment, RtcTrack } from "@/types/rtc";
import { applyReverse } from "./rtcOps";

function seg(p: Partial<RtcSegment>): RtcSegment {
	return { id: p.id || "s1", kind: "media", media: "video", targetStartUs: 0, targetDurationUs: 2_000_000, ...p };
}
function docOf(segments: RtcSegment[]): RtcDoc {
	const t: RtcTrack = { id: "t1", type: "video", segments };
	return { id: "d1", name: "测试", fps: 30, tracks: [t] };
}

describe("rtcOps.applyReverse · source 窗口镜像换算（第三批·倒放）", () => {
	it("正向→倒放：新 sourceStart = 总长 − 旧 sourceEnd，时长不变；换引用 + 记标记", () => {
		// 10s 素材取 [2s, 5s) 窗口 → 倒放副本里对应 [5s, 8s)
		const d0 = docOf([
			seg({ id: "a", assetId: "V1", uri: "u1", sourceStartUs: 2_000_000, sourceDurationUs: 3_000_000, targetStartUs: 1_000_000, targetDurationUs: 3_000_000 }),
		]);
		const d1 = applyReverse(d0, "a", { assetId: "REV1", uri: "u-rev", totalUs: 10_000_000, reversedFromAssetId: "V1" });
		const s = d1.tracks[0].segments[0];
		expect(s.assetId).toBe("REV1");
		expect(s.uri).toBe("u-rev");
		expect(s.reversedFromAssetId).toBe("V1");
		expect(s.sourceStartUs).toBe(5_000_000); // 10 − (2+3)
		expect(s.sourceDurationUs).toBe(3_000_000); // 时长不变
		// target 位置/时长一概不动
		expect(s.targetStartUs).toBe(1_000_000);
		expect(s.targetDurationUs).toBe(3_000_000);
	});

	it("两次镜像互逆：倒放再还原 → source 窗口回到原值、标记清除", () => {
		const d0 = docOf([
			seg({ id: "a", assetId: "V1", uri: "u1", sourceStartUs: 2_000_000, sourceDurationUs: 3_000_000 }),
		]);
		const d1 = applyReverse(d0, "a", { assetId: "REV1", uri: "u-rev", totalUs: 10_000_000, reversedFromAssetId: "V1" });
		const d2 = applyReverse(d1, "a", { assetId: "V1", uri: "u1", totalUs: 10_000_000, reversedFromAssetId: undefined });
		const s = d2.tracks[0].segments[0];
		expect(s.assetId).toBe("V1");
		expect(s.uri).toBe("u1");
		expect("reversedFromAssetId" in s).toBe(false); // 标记清除=字段消失
		expect(s.sourceStartUs).toBe(2_000_000);
		expect(s.sourceDurationUs).toBe(3_000_000);
	});

	it("素材总长未知（totalUs 0/缺省）→ 起点归 0、时长保持", () => {
		const d0 = docOf([seg({ id: "a", assetId: "V1", uri: "u1", sourceStartUs: 4_000_000, sourceDurationUs: 2_000_000 })]);
		const d1 = applyReverse(d0, "a", { assetId: "REV1", uri: "u-rev", reversedFromAssetId: "V1" });
		expect(d1.tracks[0].segments[0].sourceStartUs).toBe(0);
		expect(d1.tracks[0].segments[0].sourceDurationUs).toBe(2_000_000);
	});

	it("无 source 窗口（图片等）只换引用不建窗口", () => {
		const d0 = docOf([seg({ id: "a", assetId: "V1", uri: "u1" })]);
		const d1 = applyReverse(d0, "a", { assetId: "REV1", uri: "u-rev", totalUs: 5_000_000, reversedFromAssetId: "V1" });
		const s = d1.tracks[0].segments[0];
		expect(s.sourceStartUs).toBeUndefined();
		expect(s.sourceDurationUs).toBeUndefined();
		expect(s.assetId).toBe("REV1");
	});

	it("片段不存在 / placeholder → 原 doc 引用（no-op）", () => {
		const d0 = docOf([seg({ id: "a", kind: "placeholder" })]);
		expect(applyReverse(d0, "nope", { assetId: "X" })).toBe(d0);
		expect(applyReverse(d0, "a", { assetId: "X" })).toBe(d0);
	});

	it("镜像起点不为负：窗口终点越过声称总长时钳到 0", () => {
		const d0 = docOf([seg({ id: "a", assetId: "V1", uri: "u1", sourceStartUs: 8_000_000, sourceDurationUs: 4_000_000 })]);
		const d1 = applyReverse(d0, "a", { assetId: "REV1", uri: "u-rev", totalUs: 10_000_000, reversedFromAssetId: "V1" });
		expect(d1.tracks[0].segments[0].sourceStartUs).toBe(0); // 10 − 12 = −2 → 0
	});
});
