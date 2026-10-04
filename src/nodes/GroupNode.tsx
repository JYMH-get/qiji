import { NodeResizer } from "@xyflow/react";
import { dispatchCommand } from "@/command/dispatch";
import { useCanvasStore } from "@/store/canvasStore";

export function GroupNode({
  id,
  selected,
}: {
  id: string;
  selected?: boolean;
}) {
  const kind = useCanvasStore((s) => s.groups[id]?.kind ?? "default");
  const title = useCanvasStore((s) => s.nodes[id]?.data.title);
  const material = kind === "material";
  return (
    <div className={`Qiji-group-node ${material ? "is-material" : ""} ${selected ? "is-selected" : ""}`}>
      <NodeResizer
        isVisible={Boolean(selected)}
        minWidth={120}
        minHeight={120}
        lineClassName={material ? "!border-emerald-400" : "!border-[#5b8df6]"}
        handleClassName={material ? "!bg-emerald-400" : "!bg-[#5b8df6]"}
        onResize={(_, params) => {
          useCanvasStore.getState().resizeNode(id, params.width, params.height);
        }}
        onResizeEnd={(_, params) => {
          dispatchCommand({
            type: "resizeNode",
            id,
            w: params.width,
            h: params.height,
          });
        }}
      />
      <div className="absolute bottom-full left-0.5 mb-1.5 font-mono text-[9px] font-bold uppercase tracking-wider text-[#98a2b3] select-none nodrag">
        {title ? `${title} · ` : ""}{material ? "素材分组·MATERIAL" : "分组·GROUP"}
      </div>
    </div>
  );
}
