import { describe, expect, it } from "vitest";
import { blankClickSeekUs, playheadOffsetPx } from "./timelineUtil";

describe("playheadOffsetPx 播放头坐标", () => {
	it("播放头标记与贯穿线共用时间画布内坐标，不混入轨道头或面板宽度", () => {
		expect(playheadOffsetPx(0, 100)).toBe(0);
		expect(playheadOffsetPx(1_100_000, 100)).toBeCloseTo(110, 8);
		expect(playheadOffsetPx(5_000_000, 25)).toBe(125);
	});
});

describe("blankClickSeekUs 空白区手势", () => {
	it("空白区单击返回按下位置，供播放头定位", () => {
		expect(blankClickSeekUs(false, 48_250_000)).toBe(48_250_000);
	});

	it("空白区拖动框选不改变播放头", () => {
		expect(blankClickSeekUs(true, 48_250_000)).toBeNull();
	});
});
