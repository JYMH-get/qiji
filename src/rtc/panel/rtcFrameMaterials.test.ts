import { describe, expect, it } from "vitest";
import { planRtcVideoFrames, replaceRtcFrameReference } from "./rtcFrameMaterials";

const refs = [
	{ name: "reference", media: "image" as const },
	{ name: "motion", media: "video" as const },
	{ name: "end", media: "image" as const, rtcFrameRole: "last" as const },
	{ name: "start", media: "image" as const, rtcFrameRole: "first" as const },
	{ name: "sound", media: "audio" as const },
];
describe("RTC frame reference request planning", () => {
	it("omni preserves every input and tag while adding first/last constraints", () => {
		const result = planRtcVideoFrames(refs, "@Image1 看向 @Image2，@Image3 移动，@Video1 与 @Audio1", { method: "omni" });
		expect(result.refs).toEqual(refs);
		expect(result.prompt).toContain("@Image1 看向 @Image2，@Image3 移动，@Video1 与 @Audio1");
		expect(result.prompt).toContain("首帧约束：以 @Image3");
		expect(result.prompt).toContain("尾帧约束：以 @Image2");
	});
	it("frames sorts only image positions and atomically remaps legend/body tags", () => {
		const result = planRtcVideoFrames(refs, "【素材图例】@Image1 是 额外；@Image3 是 开始；\n\n@Image1 看向 @Image3，@Video1 和 @Audio1", { method: "frames" });
		expect(result.refs.map(ref => ref.name)).toEqual(["start", "motion", "end", "reference", "sound"]);
		expect(result.prompt).toContain("@Image3 是 额外；@Image1 是 开始；");
		expect(result.prompt).toContain("@Image3 看向 @Image1，@Video1 和 @Audio1");
		expect(refs.map(ref => ref.name)).toEqual(["reference", "motion", "end", "start", "sound"]);
	});
	it("explicit frames survive the regular-reference toggle without pulling unrelated refs in", () => {
		const result = planRtcVideoFrames(refs, "@Image3 到 @Image2", { method: "frames", includeReferences: false });
		expect(result.refs.map(ref => ref.name)).toEqual(["start", "end"]);
		expect(result.prompt).toContain("@Image1 到 @Image2");
	});
	it("storyboard fills a missing first role while explicit last precedes extras", () => {
		const storyboard = { name: "story", media: "image" as const };
		const result = planRtcVideoFrames(refs.filter(ref => ref.rtcFrameRole !== "first"), "@Image1 和 @Image2", { method: "frames", storyboard });
		expect(result.refs.filter(ref => ref.media === "image").map(ref => ref.name)).toEqual(["story", "end", "reference"]);
		expect(result.prompt).toContain("@Image3 和 @Image2");
	});
	it("explicit first wins over storyboard but storyboard and additional references remain", () => {
		const result = planRtcVideoFrames(refs, "body", { method: "frames", storyboard: { name: "story", media: "image" } });
		expect(result.refs.filter(ref => ref.media === "image").map(ref => ref.name)).toEqual(["start", "end", "reference", "story"]);
	});
	it("legacy requests without roles keep the old storyboard protocol unchanged", () => {
		const plain = [{ name: "reference", media: "image" as const }];
		expect(planRtcVideoFrames(plain, "body", { method: "frames", storyboard: { name: "story", media: "image" } })).toEqual({ refs: plain, prompt: "body", explicitFrames: false });
	});
	it("same-role replacement retains its slot and other reference object identities", () => {
		const next = replaceRtcFrameReference(refs, "last", { name: "new last", media: "image" });
		expect(next.map(ref => ref.name)).toEqual(["reference", "motion", "new last", "start", "sound"]);
		expect(next[0]).toBe(refs[0]); expect(next[2].rtcFrameRole).toBe("last");
	});
});
