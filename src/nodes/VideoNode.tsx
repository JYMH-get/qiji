import type { NodeProps } from "@xyflow/react";
import { BaseNode } from "./BaseNode";

export function VideoNode({ id, type, selected }: NodeProps) {
	return <BaseNode id={id} type={type || "video"} selected={selected} />;
}
