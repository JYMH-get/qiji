import { describe, expect, it, vi } from "vitest";
import { rememberMediaTime, seekMediaTime, shouldResyncMedia } from "./rtcMediaSync";

class FakeMedia extends EventTarget {
	readyState = 0;
	currentTime = 0;
	dataset: Record<string, string> = {};
}

describe("媒体时间跟随播放头", () => {
	it("元数据加载前多次移动播放头，loadedmetadata 只跳到最新目标时间", () => {
		const el = new FakeMedia();
		const spy = vi.spyOn(el, "addEventListener");
		seekMediaTime(el, 1.2);
		rememberMediaTime(el, 8.6);
		expect(spy).toHaveBeenCalledTimes(1);
		el.readyState = 1;
		el.dispatchEvent(new Event("loadedmetadata"));
		expect(el.currentTime).toBe(8.6);
	});

	it("从同一片段的其它位置开始播放时，大幅偏差必须立即重新对时", () => {
		expect(shouldResyncMedia(1, 8, true)).toBe(true);
		expect(shouldResyncMedia(7.92, 8, true)).toBe(false);
		expect(shouldResyncMedia(7.92, 8, false)).toBe(true);
	});
});
