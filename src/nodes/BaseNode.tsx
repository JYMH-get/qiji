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
import { useLibraryStore } from "@/store/libraryStore";
import {
  Type,
  Image as ImageIcon,
  Clapperboard,
  AudioLines,
  Plus,
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

const STATUS_LABEL: Record<string, string> = {
  idle: "待命",
  editing: "编辑中",
  queued: "排队中",
  scheduled: "已排期",
  running: "生成中",
  success: "完成",
  failed: "失败",
};

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
  const Icon = def.icon;
  const status = useCanvasStore((s) => s.runtime[id]?.status ?? "idle");
  const accentStyle = { "--node-accent": def.accentVar } as CSSProperties;
  const activeNodeId = useUiStore((s) => s.activeNodeId);
  const isEditing = activeNodeId === id;
  const isActive = isEditing || Boolean(selected);
  const quantity = useCanvasStore((s) =>
    Number(s.nodes[id]?.data.params?.quantity ?? 1),
  );
  const isStacked = def.canStack && quantity > 1;

  const [handleMenu, setHandleMenu] = useState<{
    handleId: string;
    type: "source" | "target";
    formats: string[];
    topPercent: number;
  } | null>(null);

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

  const assetId = useCanvasStore((s) => s.nodes[id]?.data.resultAssetId);
  const asset = useLibraryStore((s) =>
    assetId ? (s.assets[assetId] ?? null) : null,
  );
  const isUploadNode = type.startsWith("file_");
  const displayLabel = isUploadNode && asset ? asset.name : def.label;

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

  const statusText = isUploadNode ? "" : (STATUS_LABEL[status] ?? "");
  const rightLabel = resolution || statusText;

  return (
    <div className="relative w-full h-full overflow-visible">
      {/* ── 节点外部的超轻量标题栏（仅字体，无边框） ── */}
      <div className="absolute bottom-full left-0 right-0 mb-1.5 flex items-center justify-between text-[9px] text-muted-foreground select-none nodrag px-0.5">
        <div className="flex items-center gap-1 font-medium truncate max-w-[75%]">
          <Icon className="h-3 w-3 text-primary shrink-0" />
          <span className="truncate">{displayLabel}</span>
        </div>
        <span className="font-mono text-[9px] opacity-75 shrink-0">
          {rightLabel}
        </span>
      </div>

      <div
        className={`Qiji-node ${isActive ? (isEditing ? "is-editing" : "is-selected") : "Qiji-node--compact"} ${isStacked ? "Qiji-node--stacked" : ""}`}
        data-status={status}
        style={accentStyle}
        onClick={() => !isActive && useUiStore.getState().setActiveNodeId(id)}
      >
        {/* NodeResizer：激活时才显示 */}
        {isActive && (
          <NodeResizer
            isVisible={true}
            minWidth={200}
            minHeight={150}
            lineClassName="!border-[color:var(--node-accent)]"
            handleClassName="!bg-[color:var(--node-accent)]"
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
