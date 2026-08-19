import { describe, it, expect } from "vitest";
import { buildNeighborVars, shotContextText } from "@/lib/inferContext";
import type { StoryboardShot } from "@/services/projectFile";

function shot(p: Partial<StoryboardShot> & { id: string; index: number }): StoryboardShot {
	return { title: `分镜${p.index}`, scriptSegment: "", prompt: "", materials: [], ...p } as StoryboardShot;
}

describe("inferContext.buildNeighborVars", () => {
	it("邻镜优先取推理结果（故事板+视频），无结果回退原文", () => {
		const shots = [
			shot({ id: "a", index: 1, scriptSegment: "第一镜原文", storyboardPrompt: "SB1", videoPrompt: "V1" }),
			shot({ id: "b", index: 2, scriptSegment: "第二镜原文" }), // 未推理 → 原文
			shot({ id: "c", index: 3, scriptSegment: "第三镜原文", videoPrompt: "V3" }),
		];
		const v = buildNeighborVars(shots, "b", false);
		expect(v.上上一分镜).toBe(""); // b 前面只有 a，b-2 越界
		expect(v.上一分镜).toBe("SB1\nV1"); // a 有结果 → 拼故事板+视频
		expect(v.下一分镜).toBe("V3"); // c 只有视频结果
	});

	it("按 index 排序定位邻镜（数组乱序也正确）", () => {
		const shots = [
			shot({ id: "c", index: 3, scriptSegment: "S3" }),
			shot({ id: "a", index: 1, scriptSegment: "S1" }),
			shot({ id: "b", index: 2, scriptSegment: "S2" }),
		];
		const v = buildNeighborVars(shots, "c", false);
		expect(v.上上一分镜).toBe("S1");
		expect(v.上一分镜).toBe("S2");
		expect(v.下一分镜).toBe(""); // c 是最后一镜
	});

	it("同源模式取 unifiedPrompt 结果，缺失回退原文", () => {
		const shots = [
			shot({ id: "a", index: 1, scriptSegment: "S1", unifiedPrompt: "U1" }),
			shot({ id: "b", index: 2, scriptSegment: "S2" }),
		];
		const v = buildNeighborVars(shots, "b", true);
		expect(v.上一分镜).toBe("U1");
		// 非同源模式下同一 a：unifiedPrompt 不算结果 → 回退原文
		expect(shotContextText(shots[0], false)).toBe("S1");
	});

	it("shotId 不存在（已删）→ 三者皆空", () => {
		const v = buildNeighborVars([shot({ id: "a", index: 1, scriptSegment: "S1" })], "zzz", false);
		expect(v).toEqual({ 上上一分镜: "", 上一分镜: "", 下一分镜: "" });
	});

	it("第一镜：上上/上一为空，下一带内容", () => {
		const shots = [
			shot({ id: "a", index: 1, scriptSegment: "S1" }),
			shot({ id: "b", index: 2, scriptSegment: "S2" }),
		];
		const v = buildNeighborVars(shots, "a", false);
		expect(v.上上一分镜).toBe("");
		expect(v.上一分镜).toBe("");
		expect(v.下一分镜).toBe("S2");
	});
});
