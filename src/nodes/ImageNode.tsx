import type { NodeProps } from "@xyflow/react";
import { BaseNode } from "./BaseNode";

export function ImageNode({ id, type, selected }: NodeProps) {
	return <BaseNode id={id} type={type || "image"} selected={selected} />;
}
