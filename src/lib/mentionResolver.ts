/**
 * mentionResolver — 解析 prompt 中的 @[端口名] 语法，
 * 替换为上游连接节点的实际输出内容。
 *
 * 用法：用户在 prompt 中输入 @[text]，系统沿 edge 图回溯找到
 * 连接到当前节点 "text" 输入端口的上游节点，取其 resultAsset 内容。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { getPlugin } from "@/nodes/pluginRegistry";

const MENTION_RE = /@\[(\w+)]/g;

/**
 * 提取 prompt 中所有 @[xxx] mention token
 */
export function extractMentions(text: string): string[] {
	const matches: string[] = [];
	let m: RegExpExecArray | null;
	const re = new RegExp(MENTION_RE.source, "g");
	while ((m = re.exec(text)) !== null) {
		matches.push(m[1]);
	}
	return [...new Set(matches)];
}

/**
 * 查找连接到指定节点 inputPort 的上游节点 ID
 */
function findUpstreamNodeId(
	nodeId: string,
	inputPort: string,
): string | null {
	const { edges } = useCanvasStore.getState();
	for (const edge of Object.values(edges)) {
		if (edge.target === nodeId && edge.targetPort === inputPort) {
			return edge.source;
		}
	}
	return null;
}

/**
 * 获取节点的结果内容（文本内容或 URI）
 */
function getNodeResultContent(nodeId: string): string {
	const { nodes } = useCanvasStore.getState();
	const node = nodes[nodeId];
	if (!node) return "";

	const assetId = node.data.resultAssetId;
	if (!assetId) {
		// 回退到 prompt 文本
		return typeof node.data.params.prompt === "string"
			? (node.data.params.prompt as string)
			: "";
	}

	const asset = useLibraryStore.getState().assets[assetId];
	if (!asset) return "";

	// 文本/脚本类：如果有本地路径，尝试返回 URI 供引用
	// 图片/视频/音频：返回文件 URI
	return asset.uri || asset.name || "";
}

/**
 * 解析 prompt 中的所有 @[port] mention，替换为上游节点结果内容。
 * 如果上游节点无内容，保留原始 mention token。
 */
export function resolveMentions(nodeId: string, prompt: string): string {
	return prompt.replace(MENTION_RE, (_match, portName: string) => {
		const upstreamId = findUpstreamNodeId(nodeId, portName);
		if (!upstreamId) return _match; // 无上游连接，保持原样
		const content = getNodeResultContent(upstreamId);
		return content || _match;
	});
}

/**
 * 获取 mention 建议列表：当前节点的所有输入端口名 + 上游节点标签
 */
export function getMentionSuggestions(nodeId: string): {
	portName: string;
	upstreamLabel: string | null;
	upstreamNodeId: string | null;
}[] {
	const { nodes } = useCanvasStore.getState();
	const node = nodes[nodeId];
	if (!node) return [];

	const plugin = getPlugin(node.type);
	if (!plugin) return [];

	return plugin.inputs.map((input) => {
		const upstreamId = findUpstreamNodeId(nodeId, input.name);
		const upstreamNode = upstreamId ? nodes[upstreamId] : null;
		const upstreamPlugin = upstreamNode ? getPlugin(upstreamNode.type) : null;
		return {
			portName: input.name,
			upstreamLabel: upstreamPlugin?.label ?? null,
			upstreamNodeId: upstreamId,
		};
	});
}