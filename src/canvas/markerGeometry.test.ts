import { describe, expect, it } from "vitest";
import { markerArrowPoints, resizedMarkerFontSize } from "./markerGeometry";

it("拖大边框一倍字号同步一倍，缩回一半字号同步还原", () => {
	expect(resizedMarkerFontSize(18, 220, 440)).toBe(36);
	expect(resizedMarkerFontSize(36, 440, 220)).toBe(18);
});

describe("箭头从落笔起点指向终点", () => {
	it.each([
		[false, false, "0,0", "200,100"], [true, false, "200,0", "0,100"],
		[false, true, "0,100", "200,0"], [true, true, "200,100", "0,0"],
	] as const)("flipX=%s flipY=%s", (flipX, flipY, start, end) => {
		const points = markerArrowPoints(200, 100, flipX, flipY).split(" ");
		expect(points).toHaveLength(6);
		expect(points[0]).toBe(start);
		expect(points[3]).toBe(end);
		expect(points.join(" ")).not.toContain("NaN");
	});
});
