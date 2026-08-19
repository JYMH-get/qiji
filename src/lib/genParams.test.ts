import { describe, it, expect } from "vitest";
import { estimateCost } from "./genParams";

/** 与服务端 resolveModelCost + refVideoBilling 同尺（第143轮）：预估必须等于实扣 */
describe("estimateCost 参考视频按秒折算", () => {
	const mini = { cost: 30, costField: "duration", costPerUnit: 2, refVideoSecondsWeight: 1 };

	it("无参考视频：按时长计费不变", () => {
		expect(estimateCost(mini, { duration: 10 })).toBe(20);
	});

	it("系数1：计费秒数 = duration + 参考视频秒（与出片同价）", () => {
		// 10s 出片 + 17 参考秒（15+2，调用方已逐条 ceil）= 27 × 2 = 54
		expect(estimateCost(mini, { duration: 10 }, 17)).toBe(54);
	});

	it("系数0.5：折半折算 + 四舍五入与服务端一致", () => {
		const m = { ...mini, refVideoSecondsWeight: 0.5, costPerUnit: 2.5 };
		// 10 + 0.5×17 = 18.5 × 2.5 = 46.25 → 46（Math.round，与 resolveModelCost 同）
		expect(estimateCost(m, { duration: 10 }, 17)).toBe(46);
	});

	it("无系数模型：refVideoSeconds 不生效", () => {
		const m = { cost: 30, costField: "duration", costPerUnit: 2 };
		expect(estimateCost(m, { duration: 10 }, 17)).toBe(20);
	});

	it("档位路由价照吃折算秒数（1080p 档每秒价）", () => {
		const vip = {
			cost: 45, costField: "duration", costPerUnit: 3, refVideoSecondsWeight: 1,
			costRules: [{ when: { resolution: "1080p" }, cost: 113, costPerUnit: 7.5 }],
		};
		// (10 + 15) × 7.5 = 187.5 → 188（与服务端冒烟 D 同数值）
		expect(estimateCost(vip, { duration: 10, resolution: "1080p" }, 15)).toBe(188);
	});

	it("基础时长缺失：不折算、维持兜底固定价（与服务端同路径）", () => {
		expect(estimateCost(mini, {}, 17)).toBe(30);
	});

	it("按次模型（无 costField）不受影响", () => {
		expect(estimateCost({ cost: 45 }, { duration: 10 }, 17)).toBe(45);
	});

	it("缺模型返回 null", () => {
		expect(estimateCost(undefined, { duration: 10 }, 17)).toBeNull();
	});
});
