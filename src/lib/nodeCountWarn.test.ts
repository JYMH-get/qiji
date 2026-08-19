import { describe, it, expect } from "vitest";
import { nodeCountThreshold, advanceWarn } from "./nodeCountWarn";

// 第146轮：节点数量预警阈值（350/450/500/550 + 之后每10）——用户定档，锁定防漂移

describe("nodeCountThreshold", () => {
	it("阈值档位：350/450/500/550 前的边界", () => {
		expect(nodeCountThreshold(0)).toBeNull();
		expect(nodeCountThreshold(349)).toBeNull();
		expect(nodeCountThreshold(350)).toBe(350);
		expect(nodeCountThreshold(449)).toBe(350);
		expect(nodeCountThreshold(450)).toBe(450);
		expect(nodeCountThreshold(499)).toBe(450);
		expect(nodeCountThreshold(500)).toBe(500);
		expect(nodeCountThreshold(549)).toBe(500);
	});

	it("550 起每 10 一档", () => {
		expect(nodeCountThreshold(550)).toBe(550);
		expect(nodeCountThreshold(559)).toBe(550);
		expect(nodeCountThreshold(560)).toBe(560);
		expect(nodeCountThreshold(623)).toBe(620);
		expect(nodeCountThreshold(1000)).toBe(1000);
	});
});

describe("advanceWarn", () => {
	it("越过新阈值提醒一次，驻留同档不重复", () => {
		let s = advanceWarn(0, 349);
		expect(s.warnAt).toBeNull();
		s = advanceWarn(s.last, 350);
		expect(s.warnAt).toBe(350);
		s = advanceWarn(s.last, 360); // 350 档内加节点：不再提醒
		expect(s.warnAt).toBeNull();
		s = advanceWarn(s.last, 450);
		expect(s.warnAt).toBe(450);
	});

	it("跳跃式增长只提醒当前档（不补历史档）", () => {
		const s = advanceWarn(0, 565);
		expect(s.warnAt).toBe(560);
	});

	it("回落后再次越过同一阈值会重新提醒（删节点/切画布）", () => {
		let s = advanceWarn(0, 500);
		expect(s.warnAt).toBe(500);
		s = advanceWarn(s.last, 300); // 回落：last 同步回落
		expect(s.warnAt).toBeNull();
		expect(s.last).toBe(0);
		s = advanceWarn(s.last, 500);
		expect(s.warnAt).toBe(500);
	});
});
