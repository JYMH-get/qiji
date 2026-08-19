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
  data,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  // 选中节点的上下游连线高亮发光（data.active 由 Canvas 按选中节点标注）
  const active = Boolean((data as { active?: boolean } | undefined)?.active);

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
            ? "drop-shadow(0 0 7px rgba(180,200,255,0.75))"
            : active
              ? "drop-shadow(0 0 7px rgba(122,168,255,0.85))"
              : undefined,
          stroke: hovered ? "rgba(190,210,255,0.95)" : active ? "#8fb4ff" : style.stroke,
          strokeWidth: hovered ? 2.8 : active ? 2.6 : 1.8,
        }}
      />
    </g>
  );
}