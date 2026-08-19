import { describe, expect, it } from "vitest";
import type { RtcSegment } from "@/types/rtc";
import {
	AUDIO_GEN_UNSUPPORTED,
	ORPHAN_TASK_ERROR,
	PROGRESS_MIN_GAP_MS,
	PROGRESS_MIN_STEP,
	buildFreeImageParams,
	buildFreeInput,
	buildFreeVideoParams,
	clampProgress,
	failedPatch,
	genCapabilityFor,
	genPurposeFor,
	mediaPatch,
	orphanPatch,
	packTaskRef,
	parseTaskRef,
	pendingMirrorPatch,
	runningPatch,
	segPatchIsNoop,
	segSeconds,
	shouldWriteProgress,
	sourceWindowFor,
} from "./rtcGenCore";

/** 造一个占位片段 */
const holder = (p: Partial<RtcSegment> = {}): RtcSegment => ({
	id: "seg-1",
	kind: "placeholder",
	genKind: "video",
	targetStartUs: 2_000_000,
	targetDurationUs: 5_000_000,
	status: "pending",
	...p,
});

describe("rtcGenCore · taskRef 编解码（断连找回的凭据）", () => {
	it("packTaskRef：两段齐全才打包；缺任一 → 空串（调用方据此不写 taskRef）", () => {
		expect(packTaskRef("managed:gpt-image-2", "task-9")).toBe("managed:gpt-image-2|task-9");
		expect(packTaskRef("", "task-9")).toBe("");
		expect(packTaskRef("managed", "")).toBe("");
		expect(packTaskRef("  ", " ")).toBe("");
	});

	it("parseTaskRef：带竖线=runPurpose 任务（adapterKey+taskId），不带=pending 台账 id", () => {
		expect(parseTaskRef("managed:m1|task-9")).toEqual({ kind: "task", adapterKey: "managed:m1", taskId: "task-9" });
		expect(parseTaskRef("gen-1730000000000-3")).toEqual({ kind: "pending", pendingId: "gen-1730000000000-3" });
	});

	it("parseTaskRef：空/半截数据 → null（无从找回，当没有）", () => {
		expect(parseTaskRef(undefined)).toBeNull();
		expect(parseTaskRef("")).toBeNull();
		expect(parseTaskRef("   ")).toBeNull();
		expect(parseTaskRef("|task-9")).toBeNull();
		expect(parseTaskRef("adapter|")).toBeNull();
	});

	it("taskId 里含竖线也能还原（只按第一个竖线切）", () => {
		const packed = packTaskRef("managed", "task|with|pipes");
		expect(parseTaskRef(packed)).toEqual({ kind: "task", adapterKey: "managed", taskId: "task|with|pipes" });
	});
});

describe("rtcGenCore · 进度节流（进度帧绝不打满落盘链）", () => {
	it("clampProgress：收敛 0–100 整数，非数字 → 0", () => {
		expect(clampProgress(42.4)).toBe(42);
		expect(clampProgress(-5)).toBe(0);
		expect(clampProgress(300)).toBe(100);
		expect(clampProgress("x")).toBe(0);
	});

	it("首帧必写（prev 未知）", () => {
		expect(shouldWriteProgress(undefined, 0, 0, 1000)).toBe(true);
	});

	it("变化 ≥ 步进阈值 → 立刻写；小于阈值且间隔不够 → 丢弃", () => {
		expect(shouldWriteProgress(40, 40 + PROGRESS_MIN_STEP, 1000, 1050)).toBe(true);
		expect(shouldWriteProgress(40, 41, 1000, 1000 + PROGRESS_MIN_GAP_MS - 1)).toBe(false);
	});

	it("小步变化但间隔够久 → 写（长时间不动也要有反馈）", () => {
		expect(shouldWriteProgress(40, 41, 1000, 1000 + PROGRESS_MIN_GAP_MS)).toBe(true);
	});

	it("值没变一律不写（哪怕隔了很久）", () => {
		expect(shouldWriteProgress(40, 40, 1000, 999_999)).toBe(false);
	});
});

describe("rtcGenCore · 占位状态机补丁", () => {
	it("runningPatch：转生成中并清掉上一轮失败原因；taskRef/progress 按需带上", () => {
		expect(runningPatch()).toEqual({ status: "running", error: undefined });
		expect(runningPatch({ taskRef: "a|b", progress: 30 })).toEqual({
			status: "running",
			error: undefined,
			taskRef: "a|b",
			progress: 30,
		});
	});

	it("failedPatch：转失败保留原因、清进度（片段本身保留不删，用户能看到并重试）", () => {
		expect(failedPatch("上游超时")).toEqual({ status: "failed", error: "上游超时", progress: undefined });
		expect(failedPatch("")).toEqual({ status: "failed", error: "生成失败", progress: undefined });
	});

	it("mediaPatch：占位→结果**只改素材相关字段**，target 位置/时长绝不出现在补丁里", () => {
		const patch = mediaPatch("video", "http://asset.localhost/a.mp4", "video00001", {
			sourceStartUs: 0,
			sourceDurationUs: 6_000_000,
		});
		expect(patch.kind).toBe("media");
		expect(patch.media).toBe("video");
		expect(patch.assetId).toBe("video00001");
		expect(patch.sourceDurationUs).toBe(6_000_000);
		expect("targetStartUs" in patch).toBe(false);
		expect("targetDurationUs" in patch).toBe(false);
	});

	it("mediaPatch：整组占位态字段一律清空（否则成片会永远显示「生成中」）", () => {
		const patch = mediaPatch("image", "u");
		expect(patch.status).toBeUndefined();
		expect(patch.progress).toBeUndefined();
		expect(patch.taskRef).toBeUndefined();
		expect(patch.error).toBeUndefined();
		// 四个键都必须**存在**（存在且为 undefined 才能在展开时盖掉旧值）
		for (const k of ["status", "progress", "taskRef", "error"]) expect(k in patch).toBe(true);
	});

	it("mediaPatch：没有 source 窗口时不写 source 字段（宁可没有也不写假值）", () => {
		const patch = mediaPatch("image", "u", undefined, null);
		expect("sourceStartUs" in patch).toBe(false);
		expect("sourceDurationUs" in patch).toBe(false);
	});
});

describe("rtcGenCore · 台账 → 占位状态镜像（重开客户端后接得上的关键）", () => {
	it("台账在跑、占位还没转 running → 写 running；已是 running → 不重复写", () => {
		expect(pendingMirrorPatch(holder(), { id: "p1", status: "running" })).toEqual({ status: "running", error: undefined });
		expect(pendingMirrorPatch(holder({ status: "running" }), { id: "p1", status: "running" })).toBeNull();
	});

	it("台账失败 → 占位转失败并带上原因；同样的失败不重复写", () => {
		expect(pendingMirrorPatch(holder({ status: "running" }), { id: "p1", status: "failed", error: "上游 402" })).toEqual({
			status: "failed",
			error: "上游 402",
			progress: undefined,
		});
		expect(pendingMirrorPatch(holder({ status: "failed", error: "上游 402" }), { id: "p1", status: "failed", error: "上游 402" })).toBeNull();
	});

	it("已落成结果的片段绝不被打回占位（media 片段一律返回 null）", () => {
		const done = holder({ kind: "media", media: "video", status: undefined });
		expect(pendingMirrorPatch(done, { id: "p1", status: "running" })).toBeNull();
		expect(pendingMirrorPatch(done, { id: "p1", status: "failed", error: "x" })).toBeNull();
	});

	it("孤儿占位（台账查无此单）→ 转失败并给可操作说明，绝不永远转圈", () => {
		expect(orphanPatch()).toEqual({ status: "failed", error: ORPHAN_TASK_ERROR, progress: undefined });
		expect(ORPHAN_TASK_ERROR).toContain("重新生成");
	});
});

describe("rtcGenCore · 补丁 no-op 判定（高频回填不惊动落盘）", () => {
	it("逐键与现值相同 → no-op", () => {
		expect(segPatchIsNoop(holder({ status: "running", progress: 40 }), { status: "running", progress: 40 })).toBe(true);
	});

	it("任一键不同 → 需要写", () => {
		expect(segPatchIsNoop(holder({ status: "running", progress: 40 }), { status: "running", progress: 42 })).toBe(false);
	});

	it("把已有字段清成 undefined 也算变化（终态清占位字段必须真写下去）", () => {
		expect(segPatchIsNoop(holder({ status: "running", taskRef: "a|b" }), { taskRef: undefined })).toBe(false);
		expect(segPatchIsNoop(holder({ status: "running" }), { progress: undefined })).toBe(true); // 本来就没有
	});
});

describe("rtcGenCore · 产物类型 → 能力/用途", () => {
	it("video/image 有对应能力与用途；audio 两者都为 null（界面据此明确提示不支持）", () => {
		expect(genCapabilityFor("video")).toBe("video");
		expect(genCapabilityFor("image")).toBe("image");
		expect(genCapabilityFor("audio")).toBeNull();
		expect(genPurposeFor("video")).toBe("video.generate");
		expect(genPurposeFor("image")).toBe("asset.scene.image");
		expect(genPurposeFor("audio")).toBeNull();
		expect(AUDIO_GEN_UNSUPPORTED).toContain("暂不支持音频生成");
	});
});

describe("rtcGenCore · 自由占位生成参数", () => {
	const req = { durations: [5, 10, 15], resolutions: ["720p", "1080p"], aspects: ["16:9", "9:16"] };

	it("视频时长默认取占位自身长度，再按模型开放档收敛", () => {
		expect(segSeconds(5_000_000)).toBe(5);
		expect(segSeconds(0)).toBe(1); // 至少 1 秒
		const p = buildFreeVideoParams(9_000_000, undefined, req);
		expect(p.duration).toBe(10); // 9s 不在开放档 → 就近取档（clampDurationTo 同尺）
		expect(buildFreeVideoParams(3_000_000, undefined, req).duration).toBe(5); // 3s → 先夹到下限 4 → 最近档 5
		expect(p.resolution).toBe("720p");
		expect(p.aspect_ratio).toBe("16:9");
	});

	it("视频分辨率/比例取视频设置；不在模型开放档时收敛到第一档", () => {
		const p = buildFreeVideoParams(10_000_000, { resolution: "480p", aspect: "1:1" }, req);
		expect(p.duration).toBe(10);
		expect(p.resolution).toBe("720p");
		expect(p.aspect_ratio).toBe("16:9");
	});

	it("图片参数 = {size, quality}，分辨率按模型开放档收敛", () => {
		expect(buildFreeImageParams({ imageAspect: "9:16", imageResolution: "1k", imageQuality: "medium" }, [{ v: "1k" }, { v: "2k" }])).toEqual({
			size: "576x1024",
			quality: "medium",
		});
		// 档不在开放集 → 回落第一档
		expect(buildFreeImageParams({ imageAspect: "16:9", imageResolution: "4k" }, [{ v: "2k" }])).toEqual({
			size: "2048x1152",
			quality: "high",
		});
	});

	it("垫素材按模态分组且保序（对齐上游 @ImageN/@VideoN/@AudioN 编号）", () => {
		const input = buildFreeInput([
			{ url: "i1", name: "甲", media: "image" },
			{ url: "v1", name: "乙", media: "video" },
			{ url: "i2", name: "丙", media: "image" },
			{ url: "a1", media: "audio" },
		]);
		expect(input).toEqual({
			images: [
				{ url: "i1", name: "甲" },
				{ url: "i2", name: "丙" },
			],
			videos: [{ url: "v1", name: "乙" }],
			audios: [{ url: "a1", name: undefined }],
		});
	});

	it("没有垫素材 → 不带 input 字段", () => {
		expect(buildFreeInput([])).toBeUndefined();
	});
});

describe("rtcGenCore · 产物时长 → source 窗口", () => {
	it("视频/音频按真实时长建 [0, 时长]", () => {
		expect(sourceWindowFor("video", 6.5)).toEqual({ sourceStartUs: 0, sourceDurationUs: 6_500_000 });
		expect(sourceWindowFor("audio", 3)).toEqual({ sourceStartUs: 0, sourceDurationUs: 3_000_000 });
	});

	it("图片不建窗口；探不到时长也不建（宁可没有也不写假值把 trim 卡死）", () => {
		expect(sourceWindowFor("image", 3)).toBeNull();
		expect(sourceWindowFor("video", 0)).toBeNull();
		expect(sourceWindowFor("video", Number.NaN)).toBeNull();
	});
});
