import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

export function ButtonEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	style = {},
}: EdgeProps) {
	const [edgePath] = getBezierPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
	});

	return <BaseEdge id={id} path={edgePath} style={style} />;
}
