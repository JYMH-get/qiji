import { describe, expect, it } from "vitest";
import { grayToRgba, normalizeDepthToGray } from "@/lib/depthMap";

describe("normalizeDepthToGray（逆深度 → 近白远黑灰度）", () => {
	it("min-max 拉伸到 0..255：最大值（最近）=255 白、最小值（最远）=0 黑", () => {
		const g = normalizeDepthToGray([2, 6, 10]);
		expect(Array.from(g)).toEqual([0, 128, 255]);
	});

	it("负值/浮点深度同样归一化（模型原始输出无固定量纲）", () => {
		const g = normalizeDepthToGray([-1, 0, 1]);
		expect(g[0]).toBe(0);
		expect(g[1]).toBe(128);
		expect(g[2]).toBe(255);
	});

	it("平坦输入（纯色图）→ 全 128 中灰，不除零", () => {
		expect(Array.from(normalizeDepthToGray([5, 5, 5]))).toEqual([128, 128, 128]);
		expect(Array.from(normalizeDepthToGray([0]))).toEqual([128]);
	});
});

describe("grayToRgba（单通道 → RGBA）", () => {
	it("每像素展开为 R=G=B=灰度、A=255", () => {
		expect(Array.from(grayToRgba([0, 255]))).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
	});
});
