import { describe, it, expect } from "vitest";
import { sumRefVideoSeconds, __setVideoDurationForTest, useVideoDurationStore, ensureVideoDuration } from "./videoDurationStore";

describe("videoDurationStore 参考视频计费秒数", () => {
	it("逐条向上取整求和（不足1秒算1秒，非合计后取整）", () => {
		// 0.4s + 0.4s → 1 + 1 = 2（合计取整才是 1，与服务端 refVideoBilling 同尺）
		expect(sumRefVideoSeconds(["a", "b"], { a: 0.4, b: 0.4 })).toBe(2);
		// 14.211s → 15（用户素材实测值）
		expect(sumRefVideoSeconds(["c"], { c: 14.211 })).toBe(15);
		expect(sumRefVideoSeconds(["c", "d"], { c: 14.211, d: 1.4 })).toBe(17);
	});

	it("未知时长的条目暂不计（读出后再并入）", () => {
		expect(sumRefVideoSeconds(["known", "loading"], { known: 5 })).toBe(5);
		expect(sumRefVideoSeconds([], {})).toBe(0);
	});

	it("注入缓存后可经 store 读出", () => {
		__setVideoDurationForTest("blob:test-1", 2.3);
		expect(sumRefVideoSeconds(["blob:test-1"], useVideoDurationStore.getState().seconds)).toBe(3);
	});

	it("node 环境（无 <video>）ensure 不落缓存不抛错", async () => {
		ensureVideoDuration("blob:no-dom");
		await new Promise((r) => setTimeout(r, 10));
		expect(useVideoDurationStore.getState().seconds["blob:no-dom"]).toBeUndefined();
	});
});
