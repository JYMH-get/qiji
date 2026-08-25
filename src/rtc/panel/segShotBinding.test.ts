/**
 * segShotBinding 单测 —— 普通占位（无 shotRef 视频/图片占位）→ 真实分镜 的一次性升级
 * （第240轮补充6 定稿语义锁定：普通占位与分镜占位完全一致、只有分镜工作台一条实现）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { useRtcFreeGenStore } from "./rtcFreeGenStore";
import { deriveShotForCopy, deriveShotsForCopies, ensureShotForPlaceholder } from "./segShotBinding";

const SEC = 1_000_000;

function ph(p: Partial<RtcSegment> = {}): RtcSegment {
	return { id: "pl1", kind: "placeholder", targetStartUs: 0, targetDurationUs: 5 * SEC, genKind: "video", ...p };
}
function docOf(...segs: RtcSegment[]): RtcDoc {
	return { id: "d", name: "d", fps: 30, tracks: [{ id: "tv", type: "video", segments: segs }] };
}

function boot(seg: RtcSegment, extra: Record<string, unknown> = {}) {
	useProjectStore.setState({
		projectInstanceId: "pi-1",
		rtcEpisodeId: "ep1",
		mediaSettings: {},
		episodes: [{
			id: "ep1", title: "第一集", scriptText: "",
			shots: [{ id: "sh1", index: 1, title: "分镜1", scriptSegment: "已有原文", prompt: "", materials: [] }],
		}],
		...extra,
	} as any);
	useRtcStore.getState().loadDoc(docOf(seg));
	useRtcFreeGenStore.setState({ drafts: {} } as any);
}

const shots = () => useProjectStore.getState().episodes[0].shots;
const liveSeg = () => useRtcStore.getState().doc!.tracks[0].segments.find((s) => s.id === "pl1")!;

describe("ensureShotForPlaceholder（升级：占位挂真实分镜）", () => {
	beforeEach(() => useRtcFreeGenStore.setState({ drafts: {} } as any));

	it("视频占位：当前分集 append 新镜（原文空、durationSec=占位秒数、编号经 reindex）+ 片段挂 shotRef/name；幂等", () => {
		boot(ph());
		const r = ensureShotForPlaceholder("pl1");
		expect(r?.episodeId).toBe("ep1");
		expect(shots()).toHaveLength(2);
		const created = shots()[1];
		expect(created.id).toBe(r!.shotId);
		expect(created.title).toBe("分镜2"); // reindexShots 统一编号
		expect(created.scriptSegment).toBe(""); // 没有原文就空着
		expect(created.durationSec).toBe(5);
		const seg = liveSeg();
		expect(seg.shotRef).toEqual({ episodeId: "ep1", shotId: created.id });
		expect(seg.name).toBe("分镜2");
		// 幂等：再调直接返回既有 ref，分镜不再增
		expect(ensureShotForPlaceholder("pl1")).toEqual(r);
		expect(shots()).toHaveLength(2);
	});

	it("会话草稿提示词随分镜带走：视频→videoPrompt / 图片→storyboardPrompt / 同源→unifiedPrompt", () => {
		boot(ph());
		useRtcFreeGenStore.setState({ drafts: { pl1: { prompt: "拍一段追逐", refs: [] } } } as any);
		ensureShotForPlaceholder("pl1");
		expect(shots()[1].videoPrompt).toBe("拍一段追逐");

		boot(ph({ genKind: "image", targetDurationUs: 3 * SEC }));
		useRtcFreeGenStore.setState({ drafts: { pl1: { prompt: "画一张全景", refs: [] } } } as any);
		ensureShotForPlaceholder("pl1");
		expect(shots()[1].storyboardPrompt).toBe("画一张全景");
		expect(shots()[1].durationSec).toBe(3);

		boot(ph(), { mediaSettings: { imgVideoSameSource: true } });
		useRtcFreeGenStore.setState({ drafts: { pl1: { prompt: "同源词" } } } as any);
		ensureShotForPlaceholder("pl1");
		expect(shots()[1].unifiedPrompt).toBe("同源词");
	});

	it("三类不升级：originSegId 坑位 / 音频占位 / 生成中的存量自由占位 → null 且分镜零变化", () => {
		boot(ph({ originSegId: "src1" }));
		expect(ensureShotForPlaceholder("pl1")).toBeNull();
		boot(ph({ genKind: "audio" }));
		expect(ensureShotForPlaceholder("pl1")).toBeNull();
		boot(ph({ status: "running" }));
		expect(ensureShotForPlaceholder("pl1")).toBeNull();
		expect(shots()).toHaveLength(1);
		expect(liveSeg().shotRef).toBeUndefined();
	});

	it("已有 shotRef=直接返回；非占位符/片段不存在 → null", () => {
		boot(ph({ shotRef: { episodeId: "ep1", shotId: "sh1" } }));
		expect(ensureShotForPlaceholder("pl1")).toEqual({ episodeId: "ep1", shotId: "sh1" });
		expect(shots()).toHaveLength(1);
		boot({ ...ph(), kind: "media", media: "video" } as RtcSegment);
		expect(ensureShotForPlaceholder("pl1")).toBeNull();
		expect(ensureShotForPlaceholder("nope")).toBeNull();
	});
});

/* ────────────────────────── 需求⑧：复制片段 → 派生独立分镜 ────────────────────────── */

/** 造一个「源分镜 + 一个已复制落地的副本片段（无 shotRef）」的场景 */
function bootCopy(extraShots: any[] = [], msExtra: Record<string, unknown> = {}) {
	useProjectStore.setState({
		projectInstanceId: "pi-1",
		rtcEpisodeId: "ep1",
		mediaSettings: msExtra,
		episodes: [{
			id: "ep1", title: "第一集", scriptText: "",
			shots: [
				{
					id: "sh1", index: 1, title: "分镜1", scriptSegment: "原文一", prompt: "旧提示词",
					materials: [{ name: "角色A", uri: "asset://a.png" }],
					storyboardPrompt: "故事板词", videoPrompt: "视频词", videoPromptBase: "基线",
					durationSec: 7, overrides: { videoModelKey: "m-x", aspect: "9:16" },
					storyboardUri: "asset://sb.png", storyboardImages: ["asset://sb.png"],
					videoUri: "asset://v.mp4", videoUris: ["asset://v.mp4"], videoActiveKey: "u:asset://v.mp4",
				},
				{ id: "sh2", index: 2, title: "分镜2", scriptSegment: "原文二", prompt: "", materials: [] },
				...extraShots,
			],
		}],
	} as any);
	// 轨道上：源片段（挂 sh1）+ 副本片段（复制而来，已被 copiedSegTemplate 剥掉 shotRef）
	useRtcStore.getState().loadDoc(
		docOf(
			{ id: "src", kind: "placeholder", targetStartUs: 0, targetDurationUs: 5 * SEC, genKind: "video", shotRef: { episodeId: "ep1", shotId: "sh1" } },
			{ id: "cp1", kind: "placeholder", targetStartUs: 5 * SEC, targetDurationUs: 5 * SEC, genKind: "video" },
		),
	);
}
const segById = (id: string) => useRtcStore.getState().doc!.tracks[0].segments.find((s) => s.id === id)!;

describe("deriveShotForCopy（复制片段 → 独立分镜）", () => {
	it("从「分镜1」复制 → 派生「分镜1-1」：插在源分镜之后、标补镜头、片段挂新 shotRef 与新名字", () => {
		bootCopy();
		const r = deriveShotForCopy("cp1", { episodeId: "ep1", shotId: "sh1" });
		expect(r).toBeTruthy();
		const list = shots();
		expect(list.map((s) => s.title)).toEqual(["分镜1", "分镜1-1", "分镜2"]); // ⚠ 沿用既有 `-` 分隔符
		const copy = list[1];
		expect(copy.id).toBe(r!.shotId);
		expect(copy.isSupplement).toBe(true);
		expect(segById("cp1").shotRef).toEqual({ episodeId: "ep1", shotId: copy.id });
		expect(segById("cp1").name).toBe("分镜1-1");
		expect(segById("src").shotRef).toEqual({ episodeId: "ep1", shotId: "sh1" }); // 源片段分毫不动
	});

	it("用户填过的内容整份复制（原文/提示词/垫图/时长/覆盖），⚠ 生成结果一律不复制", () => {
		bootCopy();
		deriveShotForCopy("cp1", { episodeId: "ep1", shotId: "sh1" });
		const copy = shots()[1];
		expect(copy.scriptSegment).toBe("原文一");
		expect(copy.prompt).toBe("旧提示词");
		expect(copy.storyboardPrompt).toBe("故事板词");
		expect(copy.videoPrompt).toBe("视频词");
		expect(copy.videoPromptBase).toBe("基线");
		expect(copy.durationSec).toBe(7);
		expect(copy.overrides).toEqual({ videoModelKey: "m-x", aspect: "9:16" });
		// 垫图是深拷贝：改副本不影响源
		expect(copy.materials).toEqual([{ name: "角色A", uri: "asset://a.png" }]);
		expect(copy.materials[0]).not.toBe(shots()[0].materials[0]);
		// 结果各自独立（副本=再要一版的新坑位）
		expect(copy.storyboardUri).toBeUndefined();
		expect(copy.storyboardImages).toBeUndefined();
		expect(copy.videoUri).toBeUndefined();
		expect(copy.videoUris).toBeUndefined();
		expect(copy.videoActiveKey).toBeUndefined();
	});

	it("连续复制同一源 → 分镜1-1、分镜1-2（编号走 reindexShots，与表格模式一把尺）", () => {
		bootCopy();
		deriveShotForCopy("cp1", { episodeId: "ep1", shotId: "sh1" });
		// 再复制一份（新片段 cp2）
		useRtcStore.getState().commit((d) => ({
			...d,
			tracks: d.tracks.map((t) => ({
				...t,
				segments: [...t.segments, { id: "cp2", kind: "placeholder", targetStartUs: 10 * SEC, targetDurationUs: 5 * SEC, genKind: "video" } as RtcSegment],
			})),
		}));
		deriveShotForCopy("cp2", { episodeId: "ep1", shotId: "sh1" });
		expect(shots().map((s) => s.title)).toEqual(["分镜1", "分镜1-1", "分镜1-2", "分镜2"]);
	});

	it("守卫：无出处 / 片段已删 / 片段已有 shotRef / 源分镜已删 → 都不派生，分镜表零变化", () => {
		bootCopy();
		expect(deriveShotForCopy("cp1", undefined)).toBeNull();
		expect(deriveShotForCopy("nope", { episodeId: "ep1", shotId: "sh1" })).toBeNull();
		expect(deriveShotForCopy("src", { episodeId: "ep1", shotId: "sh1" })).toBeNull(); // 已有 shotRef
		expect(deriveShotForCopy("cp1", { episodeId: "ep1", shotId: "gone" })).toBeNull();
		expect(deriveShotForCopy("cp1", { episodeId: "gone", shotId: "sh1" })).toBeNull();
		expect(shots()).toHaveLength(2);
		expect(segById("cp1").shotRef).toBeUndefined();
	});

	it("deriveShotsForCopies：批量逐条派生，返回真派生条数（无出处的跳过）", () => {
		bootCopy();
		const n = deriveShotsForCopies([
			{ segId: "cp1", src: { episodeId: "ep1", shotId: "sh1" } },
			{ segId: "cp1", src: { episodeId: "ep1", shotId: "sh1" } }, // 已挂上 → 不重复派生
			{ segId: "src" }, // 无出处 → 跳过
		]);
		expect(n).toBe(1);
		expect(shots()).toHaveLength(3);
	});
});
