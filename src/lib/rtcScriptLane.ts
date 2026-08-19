/**
 * rtcScriptLane —— 原文参考车道（第238轮补充10 用户定稿语义，纯函数可单测）。
 *
 * ⚠ 核心语义（勿回退成「独立原文轨」）：原文**不是独立存在的轨道数据**，而是
 * **实时从主轨素材派生**的只读参考——
 *   - 内容 = 主轨（第一条 video 轨）各片段 shotRef 对应分镜的 scriptSegment，**现查现取**：
 *     用户在属性面板改了分镜原文 → 车道立即跟着变；
 *   - 位置 = 该片段的 target 时间窗，天然一一对应：主轨片段 挪动/拉伸/分割 → 车道自动跟随
 *     （分割成两段 = 两块同文参考块）；主轨没有素材 → 车道为空；
 *   - **不参与剪辑**：不可选中/拖动/裁剪、不落盘、不导出剪映、幂等无状态。
 *
 * 消费方：
 *   ① 时间轴派生车道 RtcTimeline（标尺下方只读参考行）；
 *   ② 预览窗原文参考条 RtcTextLayer（activeScriptLaneTexts 按播放头取活动项，
 *      显隐由 rtcStore.scriptTrackVisible 开关控制）。
 *
 * 历史：第238轮补充8-9 曾把原文落成 role:"script" 真实轨道片段并做 move/trim 配对联动——
 * 已整体废除；存量 doc 里的 role:"script" 轨由 rtcOps.pruneScriptTracks 在加载时清除。
 */
import type { RtcDoc } from "@/types/rtc";
import { mainVideoTrackId } from "@/lib/rtcOps";

/** 分集形状（结构化类型，只取用到的字段——不 import projectFile 保持零依赖可测） */
export interface ScriptLaneEpisode {
	id: string;
	shots?: { id: string; scriptSegment?: string }[];
}

/** 车道上的一个参考块：key=派生自的主轨片段 id（渲染 key 稳定）、时间窗=该片段 target 窗口 */
export interface ScriptLaneItem {
	key: string;
	startUs: number;
	durUs: number;
	text: string;
}

/**
 * 从主轨派生原文参考块：主轨各片段（placeholder 与已替换的 media 一视同仁）按 shotRef
 * 反查分镜原文，空原文/无 shotRef/查不到分镜的片段不产生块。返回按主轨片段序（已升序）。
 */
export function scriptLaneItems(doc: RtcDoc | null | undefined, episode: ScriptLaneEpisode | null | undefined): ScriptLaneItem[] {
	if (!doc || !episode) return [];
	const mainId = mainVideoTrackId(doc.tracks);
	const main = mainId ? doc.tracks.find((t) => t.id === mainId) : undefined;
	if (!main) return [];
	const textByShot = new Map<string, string>();
	for (const s of episode.shots ?? []) {
		const c = (s.scriptSegment || "").trim();
		if (c) textByShot.set(s.id, c);
	}
	if (textByShot.size === 0) return [];
	const out: ScriptLaneItem[] = [];
	for (const seg of main.segments) {
		const ref = seg.shotRef;
		if (!ref || ref.episodeId !== episode.id) continue;
		const text = textByShot.get(ref.shotId);
		if (!text) continue;
		out.push({ key: seg.id, startUs: seg.targetStartUs, durUs: seg.targetDurationUs, text });
	}
	return out;
}

/** 播放头处的活动参考文本（预览窗原文参考条用；右缘开区间与字幕同规） */
export function activeScriptLaneTexts(items: ScriptLaneItem[], tUs: number): ScriptLaneItem[] {
	return items.filter((i) => tUs >= i.startUs && tUs < i.startUs + i.durUs);
}
