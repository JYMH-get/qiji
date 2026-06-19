import { genId } from "@/lib/id";
import type { CanvasNode, NodeType } from "@/types";

export const NODE_MIME = "application/Qiji-node";
export const NODE_W = 240;
export const NODE_H = 200;

/** 创建一个空白节点（参数默认绑定该类型的默认模型）。 */
export function makeNode(type: NodeType, x: number, y: number): CanvasNode {
	return {
		id: genId(type),
		type,
		x,
		y,
		w: NODE_W,
		h: NODE_H,
		parentId: null,
		parentScriptId: null,
		data: {
			input: {},
			params: { model: "" },
			resultAssetId: null,
		},
	};
}
