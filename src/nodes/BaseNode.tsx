/**
 * BaseNode — 统一节点卡片外壳
 * - 始终有可见的深色卡片背景，不与画布融合
 * - 未激活：精简模式（无 header/footer），左上角类型徽章，左右 + 连线按钮始终 hover 可见
 * - 激活：展开完整 header / footer / NodeResizer
 */
import { useState, useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import { Handle, NodeResizer, Position } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvasStore";
import { getPlugin } from "./pluginRegistry";
import { ResultView } from "./ResultView";
import { dispatchCommand } from "@/command/dispatch";
import type { NodeType } from "@/types";
import { useUiStore } from "@/store/uiStore";

import {
  Type,
  Image as ImageIcon,
  Clapperboard,
  AudioLines,
  Plus,
  Info,
  Trash2,
  PanelBottomOpen,
} from "lucide-react";
import { HandlePopup } from "./HandlePopup";

function getFormatIconAndColor(formats: string[]) {
  if (formats.includes("image") || formats.includes("frame")) {
    return { Icon: ImageIcon, colorClass: "text-[#5b8df6]" };
  }
  if (formats.includes("video") || formats.includes("clip")) {
    return { Icon: Clapperboard, colorClass: "text-[#a3e635]" };
  }
  if (formats.includes("audio")) {
    return { Icon: AudioLines, colorClass: "text-[#b57bee]" };
  }
  if (formats.includes("text") || formats.includes("shot")) {
    return { Icon: Type, colorClass: "text-[#98a2b3]" };
  }
  return { Icon: Plus, colorClass: "text-muted-foreground" };
}



export function BaseNode({
  id,
  type,
  selected,
}: {
  id: string;
  type: NodeType;
  selected?: boolean;
}) {
  const def = getPlugin(type);
  if (!def) return null;
  const status = useCanvasStore((s) => s.runtime[id]?.status ?? "idle");
  const accentStyle = { "--node-accent": def.accentVar } as CSSProperties;
  const activeNodeId = useUiStore((s) => s.activeNodeId);
  const isEditing = activeNodeId === id;
  const isActive = isEditing || Boolean(selected);
  const quantity = useCanvasStore((s) =>
    Number(s.nodes[id]?.data.params?.quantity ?? 1),
  );
  const isStacked = def.canStack && quantity > 1;
  const zoom = useCanvasStore((s) => s.viewport.zoom);

  const [handleMenu, setHandleMenu] = useState<{
    handleId: string;
    type: "source" | "target";
    formats: string[];
    topPercent: number;
  } | null>(null);

  // ── 悬停工具栏：统一由父容器管理，避免闪烁 ──
  const [hovered, setHovered] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleMouseEnter = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHovered(true), 120);
  };
  const handleMouseLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHovered(false), 80);
  };

  const pointerStartRef = useRef<{ x: number; y: number; time: number } | null>(
    null,
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    pointerStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      time: Date.now(),
    };
  };

  const handlePointerUp = (
    e: React.PointerEvent,
    handleId: string,
    type: "source" | "target",
    formats: string[],
    topPercent: number,
  ) => {
    if (!pointerStartRef.current) return;
    const dx = Math.abs(e.clientX - pointerStartRef.current.x);
    const dy = Math.abs(e.clientY - pointerStartRef.current.y);
    const duration = Date.now() - pointerStartRef.current.time;

    // If mouse/pointer didn't move much and press was quick, treat it as a click!
    if (dx < 5 && dy < 5 && duration < 300) {
      e.stopPropagation();
      e.preventDefault();
      setHandleMenu({
        handleId,
        type,
        formats,
        topPercent,
      });
    }
    pointerStartRef.current = null;
  };



  const [resolution, setResolution] = useState<string>("");

  const onResolutionChange = useCallback(
    (resStr: string, W: number, H: number) => {
      setResolution(resStr);
      const node = useCanvasStore.getState().nodes[id];
      if (node && W && H) {
        const w = node.w ?? 240;
        const h = node.h ?? 200;
        const newH = Math.round(w * (H / W));
        if (Math.abs(h - newH) > 2) {
          dispatchCommand({ type: "resizeNode", id, w, h: newH });
        }
      }
    },
    [id],
  );


  const nodeTypeLabel =
    def.label.endsWith("素材") || def.label.endsWith("节点")
      ? def.label
      : `${def.label}节点`;
  const formattedResolution = resolution
    ? resolution.replace(/\s*[×x]\s*/gi, "*")
    : "";

  return (
    <div className="relative w-full h-full overflow-visible">
      {/* ── 节点上方常驻的类型与规格 ── */}
      <div
        className="absolute bottom-full left-0 right-0 mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground select-none nodrag px-0.5 cursor-default font-medium transition-opacity duration-150"
        style={{
          opacity: hovered ? 0 : 1,
          pointerEvents: hovered ? "none" : "auto",
        }}
      >
        <span className="opacity-90">{nodeTypeLabel}</span>
        {formattedResolution && (
          <span className="font-mono opacity-80">{formattedResolution}</span>
        )}
      </div>

      {/* ── 悬停快捷工具栏 ── */}
      <div
        className="absolute bottom-full left-1/2 mb-1.5 z-50 nodrag flex flex-row items-center gap-0.5 rounded-lg px-1 py-1 opacity-0 pointer-events-none transition-opacity duration-150 whitespace-nowrap w-max"
        style={{
          background: "rgba(18, 22, 34, 0.92)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          backdropFilter: "blur(12px)",
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
          transform: `translate(-50%, 0) scale(${1 / zoom})`,
          transformOrigin: "bottom center",
          ...(hovered ? { opacity: 1, pointerEvents: "auto" } : {}),
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <button
          className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            useUiStore.getState().setActiveNodeId(id);
          }}
          title="打开面板"
        >
          <PanelBottomOpen className="h-3 w-3 shrink-0" />
          <span>面板</span>
        </button>
        <div className="h-3 w-[1px] bg-white/10 shrink-0" />
        <button
          className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            useUiStore.getState().setNodeInfoNodeId(id);
          }}
          title="信息"
        >
          <Info className="h-3 w-3 shrink-0" />
          <span>信息</span>
        </button>
        <div className="h-3 w-[1px] bg-white/10 shrink-0" />
        <button
          className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-destructive hover:bg-destructive/10 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            dispatchCommand({ type: "deleteNode", id });
          }}
          title="删除"
        >
          <Trash2 className="h-3 w-3 shrink-0" />
          <span>删除</span>
        </button>
      </div>

      <div
        className={`Qiji-node ${isActive ? (isEditing ? "is-editing" : "is-selected") : "Qiji-node--compact"} ${isStacked ? "Qiji-node--stacked" : ""}`}
        data-status={status}
        style={accentStyle}
        onClick={() => !isActive && useUiStore.getState().setActiveNodeId(id)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* NodeResizer：激活时才显示 */}
        {isActive && (
          <NodeResizer
            isVisible={true}
            minWidth={200}
            minHeight={150}
            lineClassName="!border-[color:var(--node-accent)]"
            handleClassName="!bg-[color:var(--node-accent)]"
            onResize={(_, p) => {
              useCanvasStore.getState().resizeNode(id, p.width, p.height);
            }}
            onResizeEnd={(_, p) => {
              dispatchCommand({
                type: "resizeNode",
                id,
                w: p.width,
                h: p.height,
              });
            }}
          />
        )}

        {/* ── 输入连线按钮（hover 显示的 + 圆圈） ── */}
        {def.inputs.map((input, idx) => {
          const { Icon, colorClass } = getFormatIconAndColor(input.formats);
          const spacing = 12;
          const topPercent = 50 + (idx - (def.inputs.length - 1) / 2) * spacing;
          return (
            <Handle
              key={input.name}
              id={input.name}
              type="target"
              position={Position.Left}
              style={{ top: `${topPercent}%` }}
              className="Qiji-handle-btn"
              onPointerDown={handlePointerDown}
              onPointerUp={(e) =>
                handlePointerUp(
                  e,
                  input.name,
                  "target",
                  input.formats,
                  topPercent,
                )
              }
            >
              <Icon className={`Qiji-handle-btn__icon ${colorClass}`} />
            </Handle>
          );
        })}

        {/* ── 内容区 ── */}
        <div className="Qiji-node__body Qiji-node__body--full">
          <ResultView
            nodeId={id}
            kind={def.resultKind}
            onResolutionChange={onResolutionChange}
          />
        </div>

        {/* ── 输出连线按钮 ── */}
        {def.outputs.map((output, idx) => {
          const { Icon, colorClass } = getFormatIconAndColor(output.formats);
          const spacing = 12;
          const topPercent =
            50 + (idx - (def.outputs.length - 1) / 2) * spacing;
          return (
            <Handle
              key={output.name}
              id={output.name}
              type="source"
              position={Position.Right}
              style={{ top: `${topPercent}%` }}
              className="Qiji-handle-btn"
              onPointerDown={handlePointerDown}
              onPointerUp={(e) =>
                handlePointerUp(
                  e,
                  output.name,
                  "source",
                  output.formats,
                  topPercent,
                )
              }
            >
              <Icon className={`Qiji-handle-btn__icon ${colorClass}`} />
            </Handle>
          );
        })}
      </div>
      {handleMenu && (
        <HandlePopup
          state={handleMenu}
          nodeId={id}
          onClose={() => setHandleMenu(null)}
        />
      )}
    </div>
  );
}
