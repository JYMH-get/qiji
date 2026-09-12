/**
 * inferUpstream —— 智能推理节点的「上游类型 → 请求范围」判定。
 *
 * 用户定的规则（单卡独立为专属用途 storyboard.singleShot 后）：
 *  - 上游有**智能推理节点**（分镜n原文节点即此形态：接自分集推理/原文拆分）→ **仅单卡推理**；
 *  - 上游有**剧集分集节点**（episode.split：投影/裂变的分集流水线）→ **仅多卡推理**（含智能拆分）；
 *  - **无上游或其他上游**（如手动连全文文本节点）→ 多卡/单卡/拆分都可选。
 *
 * 仅约束请求输出范围；创作方案列表与模板联动不受单卡/多卡范围影响。
 */
import type { Purpose } from "@/contract";
import type { CanvasNode, CanvasEdge } from "@/types";
import { SMART_INFER_MULTI_TPL, SMART_INFER_SINGLE_TPL } from "@/lib/smartInferPrompts";

// 图视同源用途（图片与视频共用一段提示词）与原双结果用途**并列可选**：单卡场景多一个「同源单卡」、
// 多卡场景多一个「同源多卡」——由节点输出选择决定，同一套卡解析。

export interface SmartInferContext {
	/** single=仅单卡 / multi=仅多卡（含拆分）/ both=全部 */
	scope: "single" | "multi" | "both";
	/** 该场景允许请求的输出用途集合，不用来过滤创作方案 */
	purposes: Purpose[];
	/** 旧模板选择器的默认值；新版创作方案使用目录默认项 */
	defaultTemplateId: string;
}

const SINGLE_PURPOSES: Purpose[] = ["storyboard.singleShot", "storyboard.unifiedShot"];
const MULTI_PURPOSES: Purpose[] = ["storyboard.toVideoPrompt", "storyboard.unified", "storyboard.split"];
const ALL_PURPOSES: Purpose[] = ["storyboard.toVideoPrompt", "storyboard.unified", "storyboard.singleShot", "storyboard.unifiedShot", "storyboard.split"];

/** 按上游类型判定智能推理节点的可用用途（上游智能推理优先于剧集分集——原文节点场景） */
export function smartInferContext(
	nodeId: string,
	nodes: Record<string, CanvasNode>,
	edges: Record<string, CanvasEdge>,
): SmartInferContext {
	const upTypes = new Set<string>();
	for (const e of Object.values(edges)) {
		if (e.target !== nodeId) continue;
		const t = nodes[e.source]?.type;
		if (t) upTypes.add(t);
	}
	if (upTypes.has("smart.infer")) {
		return { scope: "single", purposes: SINGLE_PURPOSES, defaultTemplateId: SMART_INFER_SINGLE_TPL };
	}
	if (upTypes.has("episode.split")) {
		return { scope: "multi", purposes: MULTI_PURPOSES, defaultTemplateId: SMART_INFER_MULTI_TPL };
	}
	return { scope: "both", purposes: ALL_PURPOSES, defaultTemplateId: SMART_INFER_SINGLE_TPL };
}
