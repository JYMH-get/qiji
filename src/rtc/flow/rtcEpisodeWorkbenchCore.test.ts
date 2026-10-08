import { describe, expect, it, vi } from "vitest";
import type { StoryboardShot } from "@/services/projectFile";
import { episodeShotDurationPatch, episodeStoryboardUris, submitEpisodeShotBatch } from "./rtcEpisodeWorkbenchCore";

const shot: StoryboardShot = { id: "s1", index: 1, title: "分镜1", prompt: "", materials: [], durationSec: 15, overrides: { duration: 15, resolution: "1080p", videoModelKey: "model-a" } };

describe("episode workbench inputs and stored results", () => {
	it("shows current image first and retains old-only histories without duplicates", () => {
		expect(episodeStoryboardUris({ storyboardUri: "current", storyboardImages: ["older", "current", "older", ""] })).toEqual(["current", "older"]);
		expect(episodeStoryboardUris({ storyboardImages: ["old"] })).toEqual(["old"]);
		expect(episodeStoryboardUris({})).toEqual([]);
	});
	it("updates the requested duration while preserving unrelated explicit overrides", () => {
		expect(episodeShotDurationPatch(shot, "13.5")).toEqual({ durationSec: 13.5, overrides: { duration: 13.5, resolution: "1080p", videoModelKey: "model-a" } });
		expect(shot.durationSec).toBe(15);
	});
	it("allows clearing the row override back to the existing project default", () => {
		expect(episodeShotDurationPatch(shot, "")).toEqual({ durationSec: undefined, overrides: { duration: undefined, resolution: "1080p", videoModelKey: "model-a" } });
	});
	it.each(["-1", "0", "NaN", "Infinity"])("does not commit invalid duration %s", draft => {
		expect(episodeShotDurationPatch(shot, draft)).toBeNull();
	});
});

describe("episode batch submission ownership", () => {
	it("submits the clicked shot list in order and reports accepted requests only", async () => {
		const submit = vi.fn(async (id: string) => id !== "s2");
		expect(await submitEpisodeShotBatch(["s1", "s2", "s3"], () => true, submit)).toEqual({ accepted: 2, stopped: false });
		expect(submit.mock.calls.map(call => call[0])).toEqual(["s1", "s2", "s3"]);
	});
	it("does not send a request after its project/episode owner changed during preparation", async () => {
		let current = true;
		const submit = vi.fn(async () => { current = false; return true; });
		expect(await submitEpisodeShotBatch(["s1", "s2"], () => current, submit)).toEqual({ accepted: 1, stopped: true });
		expect(submit).toHaveBeenCalledTimes(1);
	});
	it("does not submit at all for a stale owner", async () => {
		const submit = vi.fn(async () => true);
		expect(await submitEpisodeShotBatch(["s1"], () => false, submit)).toEqual({ accepted: 0, stopped: true });
		expect(submit).not.toHaveBeenCalled();
	});
	it("does not add shots appended while a batch is being prepared", async () => {
		const ids = ["s1", "s2"];
		const submit = vi.fn(async () => { ids.push("later"); return true; });
		expect(await submitEpisodeShotBatch(ids, () => true, submit)).toEqual({ accepted: 2, stopped: false });
		expect(submit.mock.calls).toHaveLength(2);
	});
});
