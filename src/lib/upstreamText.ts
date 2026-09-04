/**
 * upstreamText — 画布节点的上游文本映射。
 *
 * 画布主张「不做隐形提交」：图片/视频等媒体素材已在素材区明示；但节点提示词为空（或仅图例）时，
 * 当节点没有自己的正文时，把上游文本全文直接映射到提示词编辑器与提交入参。
 *
 * `【上游文本N】` 只作为旧项目兼容标记：读取/提交时展开，不再新建或渲染胶囊。
 */
import { PRESET_TAG_RE, presetPosition } from "@/lib/presetSchemes";
import { splitLegendPrompt } from "@/lib/shotMaterials";
/** 上游文本胶囊标记：【上游文本N】（N=1-based，对应第 N 个上游文本源） */
export const upstreamTag = (n: number): string => `【上游文本${n}】`;
/** 匹配 【上游文本N】，捕获组 1 = 编号 */
export const UPSTREAM_TAG_RE = /【上游文本(\d+)】/g;

export function hasUpstreamCapsule(prompt: string): boolean {
	return /【上游文本\d+】/.test(prompt || "");
}

/** 剥掉所有上游文本胶囊（连同其后紧邻的一个换行），返回用户正文 */
export function stripUpstreamCapsules(prompt: string): string {
	return (prompt || "").replace(/【上游文本\d+】\n?/g, "");
}

/** 拼一段「1..count」的胶囊块（各占一行）；count<=0 返回空串 */
export function buildUpstreamCapsuleBlock(count: number): string {
	if (count <= 0) return "";
	return Array.from({ length: count }, (_, i) => upstreamTag(i + 1)).join("\n");
}

/** 把提示词的上游胶囊重置为恰好 1..count（幂等：先剥后前置）；count<=0 时仅剥离 */
export function setUpstreamCapsules(prompt: string, count: number): string {
	const body = stripUpstreamCapsules(prompt);
	const block = buildUpstreamCapsuleBlock(count);
	if (!block) return body;
	return body ? `${block}\n${body}` : block;
}

/** 提交时把每个 【上游文本N】 替换成第 N 个上游文本（越界→空串）。函数式 replacer 避免上游文本里的 $ 被当替换模式 */
export function expandUpstreamCapsules(prompt: string, texts: string[]): string {
	if (!hasUpstreamCapsule(prompt)) return prompt;
	return prompt.replace(new RegExp(UPSTREAM_TAG_RE.source, "g"), (_m, n: string) => texts[Number(n) - 1] ?? "");
}

function leadingPrefixPresetEnd(body: string): number {
	let i = 0;
	const re = /^\s*【预设:([A-Za-z0-9._-]+)】/;
	while (true) {
		const m = re.exec(body.slice(i));
		if (!m || presetPosition(m[1]) !== "prefix") break;
		i += m[0].length;
	}
	return i;
}

/** 把上游全文直接映射进无用户正文的节点；不写回 store，保持连线是唯一数据源。 */
export function mapUpstreamText(prompt: string, texts: string[]): string {
	const sourceText = texts.filter((text) => text.trim()).join("\n\n");
	if (hasUpstreamCapsule(prompt)) return expandUpstreamCapsules(prompt, texts);
	if (!sourceText) return prompt;

	const { legend, body } = splitLegendPrompt(prompt || "");
	const userBody = body.replace(new RegExp(PRESET_TAG_RE.source, "g"), "").trim();
	if (userBody) return prompt;

	const end = leadingPrefixPresetEnd(body);
	const before = body.slice(0, end).replace(/\s+$/, "");
	const after = body.slice(end).replace(/^\s+/, "");
	const mappedBody = [before, sourceText, after].filter(Boolean).join("\n");
	return legend ? (mappedBody ? `${legend}\n\n${mappedBody}` : legend) : mappedBody;
}
