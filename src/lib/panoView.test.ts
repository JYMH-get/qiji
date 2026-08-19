import { describe, expect, it } from "vitest";
import { isPanoramaNodeParams, normYaw, viewSet } from "@/lib/panoView";

describe("panoView（全景批量视图定义）", () => {
	it("四/六/八/十二视图数量与角度覆盖", () => {
		expect(viewSet("four")).toHaveLength(4);
		expect(viewSet("six")).toHaveLength(6);
		expect(viewSet("eight")).toHaveLength(8);
		expect(viewSet("twelve")).toHaveLength(12);
		expect(viewSet("four").map((v) => v.yaw)).toEqual([0, 90, 180, 270]);
		expect(viewSet("eight").map((v) => v.yaw)).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
	});

	it("六视图含上下（pitch ±90）；十二视图=平视/俯45/仰45 三层各四向", () => {
		const six = viewSet("six");
		expect(six.find((v) => v.label === "上")?.pitch).toBe(90);
		expect(six.find((v) => v.label === "下")?.pitch).toBe(-90);
		const twelve = viewSet("twelve");
		expect(twelve.filter((v) => v.pitch === 0)).toHaveLength(4);
		expect(twelve.filter((v) => v.pitch === -45)).toHaveLength(4);
		expect(twelve.filter((v) => v.pitch === 45)).toHaveLength(4);
	});

	it("标签唯一（落库文件名不冲突）", () => {
		for (const kind of ["four", "six", "eight", "twelve"] as const) {
			const labels = viewSet(kind).map((v) => v.label);
			expect(new Set(labels).size).toBe(labels.length);
		}
	});

	it("normYaw 归一 / 全景节点判定", () => {
		expect(normYaw(-90)).toBe(270);
		expect(normYaw(720)).toBe(0);
		expect(isPanoramaNodeParams({ panorama: {} })).toBe(true);
		expect(isPanoramaNodeParams({ purpose: "image.panorama" })).toBe(true);
		expect(isPanoramaNodeParams({ purpose: "image.viewangle" })).toBe(false);
		expect(isPanoramaNodeParams(undefined)).toBe(false);
	});
});
