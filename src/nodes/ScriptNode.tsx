import type { NodeProps } from "@xyflow/react";
import { BaseNode } from "./BaseNode";

export function ScriptNode({ id, type, selected }: NodeProps) {
	return <BaseNode id={id} type={type || "script"} selected={selected} />;
}
