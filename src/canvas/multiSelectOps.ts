/**
 * multiSelectOps —— 画布多选的批量操作（供 SelectionToolbar 与右键菜单共用）。
 *  - 一键增加预设：把预设胶囊按规范位置插入所有选中的图片节点提示词（仅图片节点，预设=图片节点专属）。
 *  - 一键检查素材：汇总所有选中节点的结果+素材，探 OSS 直链、死链自愈（复用 services/assetCheck）。
 */
import { useCanvasStore } from "@/store/canvasStore";
import { getPlugin } from "@/nodes/pluginRegistry";
import { dispatchCommand } from "@/command/dispatch";
import { insertPresetCapsule } from "@/lib/promptCompose";
import { runAssetCheck, nodeCheckTargets } from "@/services/assetCheck";

/** 选中集中的图片节点数（决定「一键增加预设」是否显示——预设仅图片节点） */
export function imageNodeCount(nodeIds: string[]): number {
	const nodes = useCanvasStore.getState().nodes;
	return nodeIds.filter((id) => {
		const n = nodes[id];
		return !!n && getPlugin(n.type)?.capability === "image";
	}).length;
}

/** 一键增加预设：把预设胶囊插入所有选中图片节点的提示词（规范位置+互斥去重）。返回生效节点数。 */
export function addPresetToNodes(nodeIds: string[], presetId: string): number {
	const nodes = useCanvasStore.getState().nodes;
	let n = 0;
	for (const id of nodeIds) {
		const node = nodes[id];
		if (!node || getPlugin(node.type)?.capability !== "image") continue;
		const prompt = typeof node.data.params.prompt === "string" ? (node.data.params.prompt as string) : "";
		const next = insertPresetCapsule(prompt, presetId);
		if (next !== prompt) {
			dispatchCommand({ type: "updateNodeParams", id, params: { prompt: next } });
			n += 1;
		}
	}
	return n;
}

/** 一键检查素材：汇总所有选中节点的结果+素材，探活+自愈+报告。 */
export function checkNodesAssets(nodeIds: string[]): void {
	const targets = nodeIds.flatMap((id) => nodeCheckTargets(id));
	void runAssetCheck(targets, "检查素材");
}
