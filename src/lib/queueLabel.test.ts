import { describe, it, expect } from "vitest";
import { progressLabel, formatDurationWithQueue } from "./queueLabel";

describe("progressLabel", () => {
	it("有位次无总数：只显示第 N 位", () => {
		expect(progressLabel(5, { queuePosition: 3 })).toBe("排队中 · 第 3 位");
	});
	it("有位次带总数：显示第 N/M 位", () => {
		expect(progressLabel(5, { queuePosition: 3, queueTotal: 8 })).toBe("排队中 · 第 3/8 位");
	});
	it("位次优先于阶段文案", () => {
		expect(progressLabel(12, { queuePosition: 1, stageText: "准备素材中" })).toBe("排队中 · 第 1 位");
	});
	it("总数小于位次（脏数据）：退化成只显示位次", () => {
		expect(progressLabel(5, { queuePosition: 4, queueTotal: 2 })).toBe("排队中 · 第 4 位");
	});
	it("仅 stageText：直接顶替进度文案", () => {
		expect(progressLabel(12, { stageText: "准备素材中" })).toBe("准备素材中");
	});
	it("空白 stageText 不生效", () => {
		expect(progressLabel(42, { stageText: "   " })).toBe("生成中 42%");
	});
	it("普通进度", () => {
		expect(progressLabel(42)).toBe("生成中 42%");
		expect(progressLabel(41.6, {})).toBe("生成中 42%");
	});
	it("无进度值：0%（null/undefined 都收——RTC 侧传的是 number|null）", () => {
		// 无进度数据 → 不凑百分比（0% 会被误读成卡住）
		expect(progressLabel(undefined)).toBe("生成中…");
		expect(progressLabel(null)).toBe("生成中…");
		expect(progressLabel(0)).toBe("生成中 0%"); // 显式 0 是真实进度，照显
	});
});

describe("formatDurationWithQueue", () => {
	it("有排队：实际生成（排队）", () => {
		// 整段墙钟 1321s，其中排队 956s → 实际 365s
		expect(formatDurationWithQueue(1_321_000, 956_000)).toBe("365s（956s）");
	});
	it("无排队耗时：退化成一位小数单值", () => {
		expect(formatDurationWithQueue(365_400)).toBe("365.4s");
		expect(formatDurationWithQueue(365_400, 0)).toBe("365.4s");
		expect(formatDurationWithQueue(365_400, null)).toBe("365.4s");
	});
	it("排队大于总耗时（脏数据）：实际钳到 0 不出负数", () => {
		expect(formatDurationWithQueue(10_000, 30_000)).toBe("0s（30s）");
	});
	it("无数据：—", () => {
		expect(formatDurationWithQueue(undefined)).toBe("—");
		expect(formatDurationWithQueue(null, 1000)).toBe("—");
	});
});
