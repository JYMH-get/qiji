import { describe, expect, it } from "vitest";
import { resolveRtcGenerationDuration } from "./rtcGenerationDuration";

describe("RTC generation duration", () => {
	it.each([
		[5_000_000, [10, 5, 15], 5],
		[5_000_001, [15, 5, 10], 10],
		[14_010_000, [5, 15, 20], 15],
		[24_000_000, [5, 20, 15], 20],
		[5_200_000, [], 6],
		[5_200_000, [NaN, Infinity, 0, -1], 6],
		[5_200_000, [NaN, 10, 5, 10, 0], 10],
	])("Auto fits %s us against %j", (target, options, expected) => {
		expect(resolveRtcGenerationDuration("auto", target, options, 15)).toBe(expected);
	});
	it("keeps a hand-picked duration even when the segment and catalog disagree", () => {
		expect(resolveRtcGenerationDuration(20, 5_100_000, [5, 10], 15)).toBe(20);
	});
	it("does not migrate legacy explicit settings when the RTC choice is absent", () => {
		expect(resolveRtcGenerationDuration(undefined, 5_100_000, [5, 10], 20)).toBe(20);
	});
	it("reads the current segment length on each new submission without altering options", () => {
		const options = [15, 5, 10];
		expect(resolveRtcGenerationDuration("auto", 4_800_000, options, 20)).toBe(5);
		expect(resolveRtcGenerationDuration("auto", 10_100_000, options, 20)).toBe(15);
		expect(options).toEqual([15, 5, 10]);
	});
});
