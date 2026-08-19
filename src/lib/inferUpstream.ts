/**
 * inferUpstream —— 智能推理节点的「上游类型 → 可用用途」判定（第108轮，单卡/多卡重做）。
 *
 * 用户定的规则（单卡独立为专属用途 storyboard.singleShot 后）：
 *  - 上游有**智能推理节点**（分镜n原文节点即此形态：接自分集推理/原文拆分）→ **仅单卡推理**；
 *  - 上游有**剧集分集节点**（episode.split：投影/裂变的分集流水线）→ **仅多卡推理**（含智能拆分）；
 *  - **无上游或其他上游**（如手动连全文文本节点）→ 多卡/单卡/拆分都可选。
 *
 * 三个消费方共用（同一把尺）：面板模板下拉过滤、执行时允许集与默认模板回退、
 * 106轮模板联动的扇出门禁（用途不符的节点不同步模板）。
 */
import type { Purpose } from "@/contract";
import type { CanvasNode, CanvasEdge } from "@/types";
import { SMART_INFER_MULTI_TPL, SMART_INFER_SINGLE_TPL } from "@/lib/smartInferPrompts";

// 图视同源用途（图片与视频共用一段提示词）与原双结果用途**并列可选**：单卡场景多一个「同源单卡」、
// 多卡场景多一个「同源多卡」——用哪套由用户选模板/项目「图视同源」开关决定，同一套卡解析。

export interface SmartInferContext {
	/** single=仅单卡 / multi=仅多卡（含拆分）/ both=全部 */
	scope: "single" | "multi" | "both";
	/** 模板下拉/执行允许的用途集合 */
	purposes: Purpose[];
	/** 该场景下未显式选模板时的默认模板 id */
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
