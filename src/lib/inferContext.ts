/**
 * inferContext — 单卡推理的「邻镜上下文」变量构建（纯函数，供 inferRun 使用 + 单测）。
 *
 * 单镜孤立推理会丢失连贯信息（站位/光影/运镜/情绪衔接）。这里把相邻分镜内容拼进提示词变量
 * {{上上一分镜}}{{上一分镜}}{{下一分镜}}，模板据此保持与前后镜的无缝衔接。
 */
import type { StoryboardShot } from "@/services/projectFile";

/** 邻镜的上下文表示：优先取该镜「推理结果」（同源=unifiedPrompt；否则 故事板+视频两段），
 *  无结果回退原文。→ 手动逐镜推理时上一镜的**结果**会拼进上下文，未推理的邻镜带其原文。 */
export function shotContextText(s: StoryboardShot | undefined, sameSource: boolean): string {
	if (!s) return "";
	const result = sameSource
		? (s.unifiedPrompt || "")
		: [s.storyboardPrompt, s.videoPrompt].filter(Boolean).join("\n");
	const script = (s.scriptSegment || s.prompt || "").trim();
	return result.trim() || script;
}

/**
 * 构建 {{上上一分镜}}{{上一分镜}}{{下一分镜}} 变量：shots=当前集全部分镜，按 index 排序后定位 shotId 的邻镜。
 * 找不到该镜（已删）→ 三者皆空串。
 */
export function buildNeighborVars(shots: StoryboardShot[], shotId: string, sameSource: boolean): Record<string, string> {
	const ordered = [...shots].sort((a, b) => a.index - b.index);
	const i = ordered.findIndex((s) => s.id === shotId);
	if (i < 0) return { 上上一分镜: "", 上一分镜: "", 下一分镜: "" };
	return {
		上上一分镜: shotContextText(ordered[i - 2], sameSource),
		上一分镜: shotContextText(ordered[i - 1], sameSource),
		下一分镜: shotContextText(ordered[i + 1], sameSource),
	};
}
