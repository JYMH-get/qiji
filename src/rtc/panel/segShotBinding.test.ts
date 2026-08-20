/**
 * segShotBinding 单测 —— 普通占位（无 shotRef 视频/图片占位）→ 真实分镜 的一次性升级
 * （第240轮补充6 定稿语义锁定：普通占位与分镜占位完全一致、只有分镜工作台一条实现）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import type { RtcDoc, RtcSegment } from "@/types/rtc";
import { useRtcFreeGenStore } from "./rtcFreeGenStore";
import { ensureShotForPlaceholder } from "./segShotBinding";

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
