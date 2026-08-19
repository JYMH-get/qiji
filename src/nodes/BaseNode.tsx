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
import { useLibraryStore } from "@/store/libraryStore";
import { getPlugin } from "./pluginRegistry";
import { ResultView } from "./ResultView";
import { ShotGroupToolbar } from "./ShotGroupView";
import { StackDrawer } from "./StackDrawer";
import { dispatchCommand } from "@/command/dispatch";
import type { NodeType } from "@/types";
import { useUiStore } from "@/store/uiStore";
import { type CaptureMode } from "@/canvas/videoCapture";
import { captureVideoNodeTo, pickCustomResultsForNode } from "@/canvas/nodeProcess";
import { annotateNode } from "@/canvas/annotate";
import { depthifyNode } from "@/canvas/depthify";
import { depthifyVideoNode } from "@/canvas/videoDepthify";
import { viewAngleNode } from "@/canvas/viewAngleOp";
import { panoramaNode, viewPanoramaNode } from "@/canvas/panoramaOp";
import { isPanoramaNodeParams } from "@/lib/panoView";

import {
  Info,
  Trash2,
  PanelBottomOpen,
  Camera,
  Film,
  Globe,
  Layers,
  Loader2,
  Orbit,
  PenLine,
  Sparkles,
  Eraser,
  Upload,
} from "lucide-react";



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
  const resultAssetId = useCanvasStore((s) => s.nodes[id]?.data.resultAssetId ?? null);
  const fileName = useCanvasStore((s) => s.nodes[id]?.data.fileName ?? null);
  // 自定义标题（裂变流水线「分镜n原文/故事板/视频」等）：优先于资产名/类型标签
  const customTitle = useCanvasStore((s) => (s.nodes[id]?.data.title || "").trim() || null);
  const resultAssetName = useLibraryStore((s) =>
    resultAssetId ? (s.assets[resultAssetId]?.name ?? null) : null,
  );
  const accentStyle = { "--node-accent": def.accentVar } as CSSProperties;
  const activeNodeId = useUiStore((s) => s.activeNodeId);
  const isEditing = activeNodeId === id;
  const isActive = isEditing || Boolean(selected);
  const quantity = useCanvasStore((s) =>
    Number(s.nodes[id]?.data.params?.quantity ?? 1),
  );
  // 抽屉式堆叠观感：媒体节点历史 ≥2（含主图）时复用 .Qiji-node--stacked 卡片纸边——
  // 必须画在节点卡层（ResultView 内探出体外的元素会被 .Qiji-node__body--full 的 overflow:hidden 裁掉）。
  const mediaStackCount = useCanvasStore((s) => {
    const d = s.nodes[id]?.data;
    if (!d) return 0;
    const hist = d.resultHistory ?? [];
    return d.resultAssetId && !hist.includes(d.resultAssetId) ? hist.length + 1 : hist.length;
  });
  const isStacked = (def.canStack && quantity > 1) || ((def.displayKind === "image" || def.displayKind === "video") && mediaStackCount > 1);
  // 处理类节点（超分/去字幕/图像超分/分段）：类型标签按用途显示，而非「生成视频/图片节点」
  const nodePurpose = useCanvasStore((s) => s.nodes[id]?.data.params?.purpose as string | undefined);
  const nodeResultOnly = useCanvasStore((s) => s.nodes[id]?.data.params?.resultOnly === true);
  // 抽屉式堆叠：本节点抽屉是否展开（同时只开一个）；拖入并入阶段（hover=悬停中 / armed=满 1 秒松开即并入）
  const stackDrawerOpen = useUiStore((s) => s.stackDrawerNodeId === id);
  const mergePhase = useUiStore((s) =>
    s.stackMerge?.targetId === id ? (s.stackMerge.armed ? "armed" : "hover") : null,
  );

  // ── 悬停工具栏：统一由父容器管理，避免闪烁 ──
  const [hovered, setHovered] = useState(false);
  // zoom 只给悬停工具栏做反缩放用：未悬停时固定返回 1（工具栏本就不可见），
  // 避免"每个节点都订阅 viewport.zoom → 缩放手势逐帧全画布节点重渲染"（性能关键，勿改回全局订阅）。
  const zoom = useCanvasStore((s) => (hovered ? s.viewport.zoom : 1));
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 工具栏元素引用：分镜组工具条里有原生 <select>——弹出的下拉是 OS 级窗口，指针移入会触发
  // mouseleave；聚焦在工具栏内（select 打开/选择中）时不收起，防止选项没点完工具栏就消失。
  const hoverbarRef = useRef<HTMLDivElement>(null);
  const handleMouseEnter = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHovered(true), 120);
  };
  const handleMouseLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      const ae = document.activeElement;
      if (ae && hoverbarRef.current?.contains(ae)) return;
      setHovered(false);
    }, 80);
  };
  // select 失焦（选完/取消）后，若指针已不在节点上，补一次收起（与上面的守卫配对）
  const handleToolbarBlur = () => {
    setTimeout(() => {
      const root = rootRef.current;
      if (root && !root.matches(":hover")) setHovered(false);
    }, 0);
  };

  const [resolution, setResolution] = useState<string>("");

  // ── 视频结果截取：当前帧/首帧/尾帧/尾段 → 落库 + 生成新节点承载（不改原节点；逻辑在 nodeProcess，右键菜单共用） ──
  const rootRef = useRef<HTMLDivElement>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  const captureToNode = useCallback(
    async (mode: CaptureMode) => {
      const video = rootRef.current?.querySelector("video") as HTMLVideoElement | null;
      setCapturing(mode);
      try {
        await captureVideoNodeTo(id, mode, video);
      } catch (err) {
        // invoke 失败会以「字符串」reject（Rust Err(String)），并非 Error 实例——需分别取值
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : (() => {
                  try {
                    return JSON.stringify(err);
                  } catch {
                    return String(err);
                  }
                })();
        alert(`截取失败：${msg || "未知错误"}`);
      } finally {
        setCapturing(null);
      }
    },
    [id],
  );

  const onResolutionChange = useCallback(
    (resStr: string, W: number, H: number) => {
      setResolution(resStr);
      const node = useCanvasStore.getState().nodes[id];
      if (node && W && H) {
        const w = node.w ?? 240;
        const h = node.h ?? 200;
        const newH = Math.round(w * (H / W));
        if (Math.abs(h - newH) > 2) {
          // 自动贴合媒体比例是展示性调整，**不走结构命令**（不进撤销栈）：
          // 否则 undo 恢复出未贴合的节点 → 图片 onLoad 又派发 resize → 把刚撤掉的状态
          // 重新推回 past 并清空 future，撤销从此原地打转（解组/截帧节点必踩）。
          useCanvasStore.getState().resizeNode(id, w, newH);
        }
      }
    },
    [id],
  );

  // 图片/视频/音频/上传节点有结果时，标题显示资产名/文件名（而非「生成图片节点」等类型名）；
  // 否则回退到类型标签。
  const display = (def.displayKind ?? def.resultKind) as string;
  const isMediaOrFile =
    display === "image" || display === "video" || display === "audio" || display === "file";
  const baseTypeLabel =
    nodePurpose === "video.upscale" ? "超分节点"
    : nodePurpose === "video.desub" ? "去字幕节点"
    : nodePurpose === "image.upscale" ? "图像超分节点"
    : nodeResultOnly ? "片段节点"
    : def.label.endsWith("素材") || def.label.endsWith("节点")
      ? def.label
      : `${def.label}节点`;
  const resultName = (resultAssetName || fileName || "").trim();
  const nodeTypeLabel = customTitle || (isMediaOrFile && resultName ? resultName : baseTypeLabel);
  const formattedResolution = resolution
    ? resolution.replace(/\s*[×x]\s*/gi, "*")
    : "";
  // 有视频结果的节点 → 悬停工具栏提供「截取」（当前帧/首帧/尾帧/尾段）
  const isVideoResult = display === "video" && !!resultAssetId;
  // 图片/视频节点 → 悬停工具栏提供「上传」自定义结果（新结果设主图，已有结果进入堆叠）
  const canUploadResult = display === "image" || display === "video";
  // 有图片结果 → 悬停工具栏提供「涂鸦」（涂鸦产物节点再点=带既有矢量继续编辑）与「转深度/转视角/全景」
  const canAnnotate = display === "image" && !!resultAssetId;
  // 全景产物节点（转全景生成的）：按钮显示「全景查看」而非「转全景」
  const isPano = useCanvasStore((s) => isPanoramaNodeParams(s.nodes[id]?.data.params as Record<string, unknown> | undefined));
  const isPanoNode = canAnnotate && isPano;
  const isUploading = status === "uploading";

  return (
    <div className="relative w-full h-full overflow-visible" ref={rootRef}>
      {/* ── 节点上方常驻的类型与规格 ── */}
      <div
        className="absolute bottom-full left-0 right-0 mb-1.5 flex items-center justify-between text-[10px] text-muted-foreground select-none nodrag px-0.5 cursor-default font-medium transition-opacity duration-150"
        style={{
          opacity: hovered ? 0 : 1,
          pointerEvents: hovered ? "none" : "auto",
        }}
      >
        <span className="opacity-90 truncate min-w-0" title={nodeTypeLabel}>{nodeTypeLabel}</span>
        {formattedResolution && (
          <span className="font-mono opacity-80 shrink-0 pl-1.5">{formattedResolution}</span>
        )}
      </div>

      {/* ── 悬停快捷工具栏 ── */}
      <div
        ref={hoverbarRef}
        className="absolute bottom-full left-1/2 mb-1.5 z-50 nodrag flex flex-row items-center gap-0.5 rounded-lg px-1 py-1 opacity-0 pointer-events-none transition-opacity duration-150 whitespace-nowrap w-max"
        style={{
          background: "rgba(18, 22, 34, 0.92)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
          transform: `translate(-50%, 0) scale(${1 / zoom})`,
          transformOrigin: "bottom center",
          // backdrop-filter 只在悬停可见时挂上（隐藏态挂着也可能被合成器逐帧处理）
          ...(hovered ? { opacity: 1, pointerEvents: "auto", backdropFilter: "blur(12px)" } : {}),
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onBlur={handleToolbarBlur}
      >
        {display === "shotgroup" && (
          <>
            <ShotGroupToolbar nodeId={id} />
            <div className="h-3 w-[1px] bg-white/10 shrink-0" />
          </>
        )}
        {isVideoResult && (
          <>
            {(
              [
                { mode: "current", label: "当前帧", icon: Camera, title: "截取当前帧为新图片节点" },
                { mode: "first", label: "首帧", icon: Camera, title: "截取首帧为新图片节点" },
                { mode: "last", label: "尾帧", icon: Camera, title: "截取尾帧为新图片节点" },
                { mode: "tail", label: "尾段", icon: Film, title: "截取最后约4秒为新视频节点" },
              ] as const
            ).map((it) => (
              <button
                key={it.mode}
                disabled={capturing !== null}
                className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-wait"
                onClick={(e) => {
                  e.stopPropagation();
                  void captureToNode(it.mode);
                }}
                title={it.title}
              >
                {capturing === it.mode ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                ) : (
                  <it.icon className="h-3 w-3 shrink-0" />
                )}
                <span>{it.label}</span>
              </button>
            ))}
            <div className="h-3 w-[1px] bg-white/10 shrink-0" />
            {(
              [
                { kind: "upscale", label: "超分", icon: Sparkles, title: "超分（画质增强，火山引擎）：选版本后在右侧生成新视频节点承载结果" },
                { kind: "desub", label: "去字幕", icon: Eraser, title: "去字幕（火山引擎）：在右侧生成新视频节点承载结果" },
              ] as const
            ).map((it) => (
              <button
                key={it.kind}
                className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                onClick={(e) => {
                  e.stopPropagation();
                  useUiStore.getState().setNodeProcModal({ nodeId: id, kind: it.kind });
                }}
                title={it.title}
              >
                <it.icon className="h-3 w-3 shrink-0" />
                <span>{it.label}</span>
              </button>
            ))}
            <button
              className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                // 视频转深度节点自身：按钮=重新转深度（本地重跑，不再套娃新建节点）
                if (type === "video.depth") dispatchCommand({ type: "run", nodeId: id });
                else depthifyVideoNode(id);
              }}
              title={type === "video.depth"
                ? "重新转深度：对原视频按原帧率重新逐帧本地推理（优先上游连线视频；不调模型零计费）"
                : "转深度：按原帧率逐帧本地推理生成灰度深度视频（近白远黑），在右侧新建转深度节点承载（模型已内置，无需联网；耗时随视频时长）"}
            >
              <Layers className="h-3 w-3 shrink-0" />
              <span>{type === "video.depth" ? "重新转深度" : "转深度"}</span>
            </button>
            <div className="h-3 w-[1px] bg-white/10 shrink-0" />
          </>
        )}
        {canAnnotate && (
          <>
            <button
              className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                annotateNode(id);
              }}
              title="涂鸦：笔/箭头/图形/文字画在图上，完成后合成图落为新图片节点（涂鸦产物节点可继续编辑）"
            >
              <PenLine className="h-3 w-3 shrink-0" />
              <span>涂鸦</span>
            </button>
            <button
              className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                // 转深度节点自身：按钮=重新转深度（本地重跑，不再套娃新建节点）
                if (type === "image.depth") dispatchCommand({ type: "run", nodeId: id });
                else depthifyNode(id);
              }}
              title={type === "image.depth"
                ? "重新转深度：对原图重新本地推理（优先上游连线图片；不调模型零计费）"
                : "转深度：本地推理生成黑白深度图（近白远黑），在右侧新建转深度节点承载（模型已内置，无需联网）"}
            >
              <Layers className="h-3 w-3 shrink-0" />
              <span>{type === "image.depth" ? "重新转深度" : "转深度"}</span>
            </button>
            <button
              className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                viewAngleNode(id);
              }}
              title="转视角：多角度编辑器选机位（环绕/俯仰/景别/预设），图像编辑模型按新视角重拍，在右侧新建图片节点承载"
            >
              <Orbit className="h-3 w-3 shrink-0" />
              <span>转视角</span>
            </button>
            <button
              className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                if (isPanoNode) viewPanoramaNode(id);
                else panoramaNode(id);
              }}
              title={isPanoNode
                ? "720°全景查看：拖动转视角、滚轮缩放；可截取当前视角/四视图/六视图/八视图/十二视图落回画布"
                : "转全景：以本图为正前方生成 equirect 2:1 的 720°全景图（右侧新建图片节点承载，完成后可全景查看）"}
            >
              <Globe className="h-3 w-3 shrink-0" />
              <span>{isPanoNode ? "全景查看" : "转全景"}</span>
            </button>
            <div className="h-3 w-[1px] bg-white/10 shrink-0" />
          </>
        )}
        {canUploadResult && (
          <>
            <button
              disabled={isUploading}
              className="flex flex-row items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-wait"
              onClick={(e) => {
                e.stopPropagation();
                pickCustomResultsForNode(id, display === "video" ? "video" : "image");
              }}
              title={`上传本地${display === "video" ? "视频" : "图片"}作为结果（可多选；已有结果自动进入堆叠）`}
            >
              {isUploading ? (
                <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
              ) : (
                <Upload className="h-3 w-3 shrink-0" />
              )}
              <span>上传</span>
            </button>
            <div className="h-3 w-[1px] bg-white/10 shrink-0" />
          </>
        )}
        {display !== "shotgroup" && (
          <>
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
          </>
        )}
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
        // 单击=只选中（RF 选中态即 is-selected 样式），**双击**才开面板（Canvas.onNodeDoubleClick 统一处理）
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* 生成中/执行中：流动绿色边框（独立元素，避免与 --stacked 伪元素冲突） */}
        {(status === "running" || status === "queued" || status === "uploading") && (
          <div className="Qiji-node__runring" aria-hidden />
        )}

        {/* NodeResizer：激活时才显示 */}
        {isActive && (
          <NodeResizer
            isVisible={true}
            minWidth={200}
            minHeight={150}
            // 图片/视频结果（已上报分辨率→node 宽高已贴合媒体比例）缩放时锁定比例，避免拉伸变形
            keepAspectRatio={!!resolution}
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

        {/* ── 输入连接点（无图标，直接拖拽连接；拖到空白处弹出生成上游节点菜单） ── */}
        {def.inputs.map((input, idx) => {
          const spacing = 14;
          const topPercent = 50 + (idx - (def.inputs.length - 1) / 2) * spacing;
          return (
            <Handle
              key={input.name}
              id={input.name}
              type="target"
              position={Position.Left}
              style={{ top: `${topPercent}%` }}
              className="Qiji-handle-dot"
            />
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

        {/* ── 输出连接点（无图标，直接拖拽连接；拖到空白处弹出生成下游节点菜单） ── */}
        {def.outputs.map((output, idx) => {
          const spacing = 14;
          const topPercent =
            50 + (idx - (def.outputs.length - 1) / 2) * spacing;
          return (
            <Handle
              key={output.name}
              id={output.name}
              type="source"
              position={Position.Right}
              style={{ top: `${topPercent}%` }}
              className="Qiji-handle-dot"
            />
          );
        })}

        {/* ── 并入堆叠悬停指示：外部同类节点拖到本节点上（悬停虚线 → 满 1.5 秒实线，松开并入抽屉） ── */}
        {mergePhase && (
          <div
            aria-hidden
            className={`absolute -inset-1 z-[55] rounded-[inherit] pointer-events-none border-2 ${
              mergePhase === "armed"
                ? "border-emerald-400"
                : "border-dashed border-amber-300/80 animate-pulse"
            }`}
          >
            <span
              className={`absolute -top-6 left-1/2 -translate-x-1/2 rounded-full px-2 py-0.5 text-[9px] font-medium whitespace-nowrap ${
                mergePhase === "armed"
                  ? "bg-emerald-500/90 text-white"
                  : "bg-black/80 text-white/85 border border-white/15"
              }`}
            >
              {mergePhase === "armed" ? "松开并入堆叠" : "停留 1.5 秒并入堆叠…"}
            </span>
          </div>
        )}
      </div>

      {/* ── 抽屉式堆叠展开视图（锚在节点右侧；同时只开一个） ── */}
      {stackDrawerOpen && <StackDrawer nodeId={id} />}
    </div>
  );
}
