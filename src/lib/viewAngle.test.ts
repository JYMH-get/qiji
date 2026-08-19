import { describe, expect, it } from "vitest";
import { shotFromScale, SHOT_SCALES, VIEW_PRESETS } from "@/lib/viewAngle";

// ⚠ 提示词相关测试已随第193轮移除：提示词渲染整体搬去服务端（客户端零提示词文案），
// 这里只测取景器 UI 的档位换算与预设。

describe("viewAngle（转视角 UI 参数模型）", () => {
	it("shotFromScale：缩放（等效距离）→ 景别档；SHOT_SCALES 反查自洽", () => {
		expect(shotFromScale(1.8)).toBe(0);
		expect(shotFromScale(1.0)).toBe(2);
		expect(shotFromScale(0.45)).toBe(4);
		SHOT_SCALES.forEach((s, i) => expect(shotFromScale(s)).toBe(i));
	});

	it("预设：六档齐全且参数在合法范围", () => {
		expect(VIEW_PRESETS.length).toBe(6);
		for (const v of VIEW_PRESETS) {
			expect(v.params.az).toBeGreaterThanOrEqual(0);
			expect(v.params.az).toBeLessThan(360);
			expect(Math.abs(v.params.el)).toBeLessThanOrEqual(90);
			expect(v.params.shot).toBeGreaterThanOrEqual(0);
			expect(v.params.shot).toBeLessThanOrEqual(4);
		}
	});
});
