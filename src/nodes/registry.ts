import type { ComponentType } from "react";
import type { NodeProps } from "@xyflow/react";
import type { NodeType } from "@/types";
import { TextNode } from "./TextNode";
import { ScriptNode } from "./ScriptNode";
import { ImageNode } from "./ImageNode";
import { VideoNode } from "./VideoNode";
import { AudioNode } from "./AudioNode";

export { NODE_REGISTRY, NODE_ORDER } from "./nodeMetadata";
export type { BusinessNodeType, NodeTypeDef } from "./nodeMetadata";

/** React Flow nodeTypes 静态映射，彻底杜绝 ESM 循环加载产生 undefined 的可能。 */
export const reactFlowNodeTypes: Record<NodeType, ComponentType<NodeProps>> = {
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
