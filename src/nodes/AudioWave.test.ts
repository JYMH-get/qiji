import { describe, it, expect } from "vitest";
import { pseudoPeaks, AUDIO_NODE_H } from "./AudioWave";

// 第145轮：音频卡占位波形（解码失败/进行中显示）——确定性锁定，防同一素材波形跳变

describe("pseudoPeaks", () => {
	it("同一 uri 恒同形（确定性），不同 uri 形状不同", () => {
		const a1 = pseudoPeaks("asset://a.mp3");
		const a2 = pseudoPeaks("asset://a.mp3");
		const b = pseudoPeaks("asset://b.mp3");
		expect(a1).toEqual(a2);
		expect(a1).not.toEqual(b);
	});

	it("默认 48 根柱、值域在 (0,1] 内（可直接按高度绘制）", () => {
		const p = pseudoPeaks("x");
		expect(p).toHaveLength(48);
		for (const v of p) {
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it("紧凑高度常量存在（音频节点自动收紧的目标高度）", () => {
		expect(AUDIO_NODE_H).toBeGreaterThan(60);
		expect(AUDIO_NODE_H).toBeLessThan(150);
	});
});
