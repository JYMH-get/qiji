import { useState, useCallback } from "react";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { dispatchCommand } from "@/command/dispatch";

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
  const [hovered, setHovered] = useState(false);

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const onEdgeClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      dispatchCommand({ type: "disconnect", edgeId: id });
    },
    [id],
  );

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* 40px 宽命中区域，提升连线可点击性 */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={40}
        style={{ cursor: "pointer" }}
        onClick={onEdgeClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dispatchCommand({ type: "disconnect", edgeId: id });
        }}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          filter: hovered
            ? "drop-shadow(0 0 6px rgba(160,180,220,0.65))"
            : undefined,
          stroke: hovered ? "rgba(160,180,220,0.9)" : style.stroke,
          strokeWidth: hovered ? 2.5 : 1.5,
        }}
      />
    </g>
  );
}