import type { NodeProps } from "@xyflow/react";
import { BaseNode } from "./BaseNode";

export function TextNode({ id, type, selected }: NodeProps) {
	return <BaseNode id={id} type={type || "text"} selected={selected} />;
}
