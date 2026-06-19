import React from "react";
import type { ComponentType } from "react";
import type { NodeProps } from "@xyflow/react";
import type { NodeType } from "@/types";
import { TextNode } from "./TextNode";
import { ScriptNode } from "./ScriptNode";
import { ImageNode } from "./ImageNode";
import { VideoNode } from "./VideoNode";
import { AudioNode } from "./AudioNode";
import { BaseNode } from "./BaseNode";

export { NODE_REGISTRY, NODE_ORDER } from "./nodeMetadata";
export type { BusinessNodeType, NodeTypeDef } from "./nodeMetadata";

const staticTypes: Record<NodeType, ComponentType<NodeProps>> = {
	text: TextNode as any,
	script: ScriptNode as any,
	image: ImageNode as any,
	video: VideoNode as any,
	audio: AudioNode as any,
	file_image: ImageNode as any,
	file_video: VideoNode as any,
	file_audio: AudioNode as any,
	file_document: ScriptNode as any,
} as any;

/** React Flow nodeTypes 映射，支持使用 Proxy 动态分发任何推送进来的节点类型。 */
export const reactFlowNodeTypes = new Proxy(staticTypes, {
	get(target, prop) {
		if (typeof prop === "string" && !(prop in target)) {
			return function DynamicGenericNode(props: NodeProps) {
				return React.createElement(BaseNode, { id: props.id, type: props.type || (prop as string), selected: props.selected });
			};
		}
		return target[prop as string];
	}
}) as any;

