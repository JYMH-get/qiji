import { describe, it, expect } from "vitest";
import type { RtcSegment } from "@/types/rtc";
import { describeSegment } from "./RtcTrackLane";

/** 造片段：默认一条 3s 的占位 */
function seg(p: Partial<RtcSegment> = {}): RtcSegment {
	return {
		id: "s1",
		kind: "placeholder",
		targetStartUs: 0,
		targetDurationUs: 3_000_000,
		...p,
	};
}

describe("describeSegment：状态 → 展示形态", () => {
	it("媒体片段=media 形态，无状态文案无进度条无虚线", () => {
		const v = describeSegment(seg({ kind: "media", media: "video", name: "a.mp4" }), 300);
		expect(v.kind).toBe("media");
		expect(v.statusText).toBe("");
		expect(v.showProgressBar).toBe(false);
		expect(v.dashed).toBe(false);
		expect(v.danger).toBe(false);
	});

	it("占位片段缺省=待生成（虚线，不画进度条）", () => {
		const v = describeSegment(seg({ name: "分镜1" }), 300);
		expect(v.kind).toBe("pending");
		expect(v.statusText).toBe("待生成");
		expect(v.dashed).toBe(true);
		expect(v.showProgressBar).toBe(false);
		expect(v.title).toContain("分镜1");
		expect(v.title).toContain("待生成");
	});

	it("生成中：进度条 + 归一化百分比", () => {
		const v = describeSegment(seg({ status: "running", progress: 42.6 }), 300);
		expect(v.kind).toBe("running");
		expect(v.showProgressBar).toBe(true);
		expect(v.progress).toBe(43);
		expect(v.showPercent).toBe(true);
		expect(v.dashed).toBe(true);
		expect(v.title).toContain("生成中 43%");
	});

	it("生成中但没有进度值 → 不确定态（progress=null，画流动条纹）", () => {
		for (const p of [undefined, NaN, Infinity]) {
			const v = describeSegment(seg({ status: "running", progress: p as number | undefined }), 300);
			expect(v.progress).toBeNull();
			expect(v.showProgressBar).toBe(true);
			expect(v.showPercent).toBe(false);
			expect(v.title).toContain("生成中");
		}
	});

	it("进度越界按 0..100 收敛", () => {
		expect(describeSegment(seg({ status: "running", progress: 180 }), 300).progress).toBe(100);
		expect(describeSegment(seg({ status: "running", progress: -20 }), 300).progress).toBe(0);
	});

	it("窄片段省略文案与百分比（只留进度条）", () => {
		const v = describeSegment(seg({ status: "running", progress: 50 }), 40);
		expect(v.compact).toBe(true);
		expect(v.showPercent).toBe(false);
		expect(v.showProgressBar).toBe(true);
	});

	it("失败：红色描边形态 + 原因进 title（片段保留不消失）", () => {
		const v = describeSegment(seg({ status: "failed", error: "上游超时", name: "分镜3" }), 300);
		expect(v.kind).toBe("failed");
		expect(v.danger).toBe(true);
		expect(v.dashed).toBe(false);
		expect(v.showProgressBar).toBe(false);
		expect(v.title).toContain("生成失败");
		expect(v.title).toContain("上游超时");
	});

	it("失败无 error 时 title 也不炸", () => {
		const v = describeSegment(seg({ status: "failed" }), 300);
		expect(v.title).toContain("生成失败");
	});

	it("genKind 决定产物图标；缺省回退片段 media，再缺省为 null", () => {
		expect(describeSegment(seg({ genKind: "image" }), 300).genKind).toBe("image");
		expect(describeSegment(seg({ media: "audio" }), 300).genKind).toBe("audio");
		expect(describeSegment(seg({}), 300).genKind).toBeNull();
	});

	it("shotRef → 「镜」章；originSegId → 版本角标 + title 说明", () => {
		const a = describeSegment(seg({ shotRef: { episodeId: "e1", shotId: "s1" } }), 300);
		expect(a.isShot).toBe(true);
		expect(a.isVersion).toBe(false);
		const b = describeSegment(seg({ originSegId: "seg-old" }), 300);
		expect(b.isVersion).toBe(true);
		expect(b.title).toContain("重新生成的新版本");
	});

	it("media 片段带着 status 也照常呈现（不静默吞状态）", () => {
		const v = describeSegment(seg({ kind: "media", media: "video", status: "running", progress: 10 }), 300);
		expect(v.kind).toBe("running");
		expect(v.showProgressBar).toBe(true);
	});

	it("宽度非法按窄片段处理", () => {
		expect(describeSegment(seg({ status: "running", progress: 30 }), NaN).compact).toBe(true);
	});
});
