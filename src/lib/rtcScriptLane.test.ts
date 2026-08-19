/**
 * rtcScriptLane —— 原文参考车道派生单测（补充10 定稿语义锁定）：
 * 原文=实时从主轨片段 shotRef 派生，非独立数据——挪动/分割/伸缩一一对应、
 * 分镜原文改了立即变、主轨没素材车道为空、不含任何落盘状态。
 */
import { describe, expect, it } from "vitest";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { moveSegment, splitSegment, trimSegment } from "./rtcOps";
import { activeScriptLaneTexts, scriptLaneItems } from "./rtcScriptLane";

const SEC = 1_000_000;

function seg(id: string, startUs: number, durUs: number, extra: Partial<RtcSegment> = {}): RtcSegment {
	return {
		id, kind: "media", media: "video", uri: `u://${id}`,
		targetStartUs: startUs, targetDurationUs: durUs,
		sourceStartUs: 0, sourceDurationUs: durUs,
		...extra,
	};
}
const ref = (shotId: string) => ({ shotRef: { episodeId: "e1", shotId } });

const EP = {
	id: "e1",
	shots: [
		{ id: "s1", scriptSegment: "第一镜原文" },
		{ id: "s2", scriptSegment: "  " }, // 空白原文：不产生块
		{ id: "s3", scriptSegment: "第三镜原文" },
	],
};

function baseDoc(): RtcDoc {
	return {
		id: "d", name: "d", fps: 30,
		tracks: [
			{ id: "tv", type: "video", segments: [
				seg("v1", 0, 5 * SEC, ref("s1")),
				seg("v2", 5 * SEC, 2 * SEC, ref("s2")),          // 原文为空白 → 无块
				{ id: "v3", kind: "placeholder", targetStartUs: 7 * SEC, targetDurationUs: 3 * SEC, ...ref("s3") }, // 占位符也派生
				seg("v4", 10 * SEC, SEC),                        // 无 shotRef → 无块
				seg("v5", 11 * SEC, SEC, { shotRef: { episodeId: "eX", shotId: "s1" } }), // 别的分集 → 无块
			] },
			{ id: "tv2", type: "video", segments: [seg("o1", 0, 9 * SEC, ref("s3"))] }, // 非主轨：不参与
		],
	};
}

describe("scriptLaneItems 派生（主轨 → 原文参考块）", () => {
	it("只看主轨；media/placeholder 一视同仁；空原文/无 shotRef/异分集/查不到分镜 不产生块", () => {
		const items = scriptLaneItems(baseDoc(), EP);
		expect(items.map((i) => [i.key, i.startUs, i.durUs, i.text])).toEqual([
			["v1", 0, 5 * SEC, "第一镜原文"],
			["v3", 7 * SEC, 3 * SEC, "第三镜原文"],
		]);
	});

	it("主轨没有素材 / 无分集 / 无 doc → 车道为空", () => {
		const empty: RtcDoc = { id: "d", name: "d", fps: 30, tracks: [{ id: "tv", type: "video", segments: [] }] };
		expect(scriptLaneItems(empty, EP)).toEqual([]);
		expect(scriptLaneItems(baseDoc(), null)).toEqual([]);
		expect(scriptLaneItems(null, EP)).toEqual([]);
	});

	it("一一对应：主轨片段 挪动/伸缩/分割 后重新派生即时跟随（分割=两块同文）", () => {
		const moved = moveSegment(baseDoc(), "v1", "tv", 20 * SEC);
		expect(scriptLaneItems(moved, EP).find((i) => i.key === "v1")!.startUs).toBe(20 * SEC);

		const trimmed = trimSegment(baseDoc(), "v1", "end", -1 * SEC);
		expect(scriptLaneItems(trimmed, EP).find((i) => i.key === "v1")!.durUs).toBe(4 * SEC);

		const split = splitSegment(baseDoc(), "v1", 2 * SEC);
		const parts = scriptLaneItems(split, EP).filter((i) => i.text === "第一镜原文");
		expect(parts).toHaveLength(2);
		expect(parts[0].durUs).toBe(2 * SEC);
		expect(parts[1].startUs).toBe(2 * SEC);
		expect(parts[1].durUs).toBe(3 * SEC);
	});

	it("原文实时提取：分镜 scriptSegment 改了 → 同一 doc 重新派生即是新文本", () => {
		const edited = { ...EP, shots: EP.shots.map((s) => (s.id === "s1" ? { ...s, scriptSegment: "改过的原文" } : s)) };
		expect(scriptLaneItems(baseDoc(), edited)[0].text).toBe("改过的原文");
	});
});

describe("activeScriptLaneTexts（预览窗参考条取活动项，右缘开区间）", () => {
	it("播放头在块内取到、右缘时刻不取（与字幕同规）", () => {
		const items = scriptLaneItems(baseDoc(), EP);
		expect(activeScriptLaneTexts(items, 1 * SEC).map((i) => i.text)).toEqual(["第一镜原文"]);
		expect(activeScriptLaneTexts(items, 5 * SEC)).toEqual([]); // v1 右缘开区间、s2 空原文无块
		expect(activeScriptLaneTexts(items, 8 * SEC).map((i) => i.text)).toEqual(["第三镜原文"]);
	});
});
