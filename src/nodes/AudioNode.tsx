import type { NodeProps } from "@xyflow/react";
import { BaseNode } from "./BaseNode";

export function AudioNode({ id, type, selected }: NodeProps) {
	return <BaseNode id={id} type={type || "audio"} selected={selected} />;
}
