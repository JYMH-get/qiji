import { describe, expect, it, vi } from "vitest";
import { scrollToRtcShot } from "./rtcShotReveal";

function viewport(top: number, bottom: number) {
	const scrollTo = vi.fn();
	const element = {
		scrollTop: 200,
		querySelectorAll: () => [{ dataset: { seg: "target" }, getBoundingClientRect: () => ({ top, bottom }) }],
		getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
		scrollTo,
	} as unknown as HTMLElement;
	return { element, scrollTo };
}

describe("分镜列表平滑定位", () => {
	it("同一次平滑滚动到片段起点，并将下方轨道移入可见区域", () => {
		const { element, scrollTo } = viewport(530, 590);
		expect(scrollToRtcShot(element, "target", 30_000_000, 80, 50)).toBe(true);
		expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 2376, top: 298, behavior: "smooth" });
	});
	it("上方轨道定位避开标尺和原文车道，起点不滚到负数", () => {
		const { element, scrollTo } = viewport(120, 160);
		scrollToRtcShot(element, "target", 0, 80, 50);
		expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 166, behavior: "smooth" });
	});
	it("目标轨道已可见时保持竖向位置；重复定位仍可重新启动滚动", () => {
		const { element, scrollTo } = viewport(180, 230);
		scrollToRtcShot(element, "target", 2_000_000, 80, 50);
		scrollToRtcShot(element, "target", 2_000_000, 80, 50);
		expect(scrollTo).toHaveBeenCalledTimes(2);
		expect(scrollTo).toHaveBeenLastCalledWith({ left: 136, top: 200, behavior: "smooth" });
	});
	it("目标删除或尚未挂载时不滚动其他片段", () => {
		const { element, scrollTo } = viewport(180, 230);
		expect(scrollToRtcShot(element, "deleted", 2_000_000, 80, 50)).toBe(false);
		expect(scrollTo).not.toHaveBeenCalled();
	});
});
