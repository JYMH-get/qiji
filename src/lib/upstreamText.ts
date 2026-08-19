/**
 * upstreamText — 画布节点「上游文本胶囊」（明示上游文本入参）。
 *
 * 画布主张「不做隐形提交」：图片/视频等媒体素材已在素材区明示；但节点提示词为空（或仅图例）时，
 * pluginRegistry 会**静默**把上游文本节点的输出当作输入——用户看不到。为此在提示词框显示**逐个编号**的
 * 上游文本胶囊 `【上游文本1】【上游文本2】…`（每个上游文本源一枚，青色 pill），提交时由 pluginRegistry
 * 按编号还原成对应上游节点的文本。
 *
 * 纯字符串工具（不依赖 store）：标记/正则/增删/展开。上游文本源的探测在 nodeMaterials.upstreamTextSources
 * （其顺序即编号顺序），提交时的展开在 pluginRegistry。
 */
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
