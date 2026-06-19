import { useCallback, useEffect, useMemo, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  SelectionMode,
  type DefaultEdgeOptions,
  type Edge,
  type Node,
  type OnSelectionChangeParams,
  type ProOptions,
} from "@xyflow/react";
import { MiniMapCustom } from "./MiniMapCustom";
import { listPlugins } from "@/nodes/pluginRegistry";
import { reactFlowNodeTypes } from "@/nodes/registry";
import { GroupNode } from "@/nodes/GroupNode";
import { ButtonEdge } from "./ButtonEdge";
import { makeIsValidConnection } from "@/dag/validate";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { dispatchCommand } from "@/command/dispatch";
import { AnimatePresence } from "motion/react";
import { OperationPanel } from "@/panel/OperationPanel";
import { VideoOperationPanel } from "@/panel/VideoOperationPanel";
import { Combine, Trash2, Ungroup } from "lucide-react";
import { ImageEditPanel } from "@/panel/ImageEditPanel";
import { NodeInfoPopover } from "@/nodes/NodeInfoModal";
import {
  useCanvasKeyboard,
  useCanvasViewport,
  useCanvasDrag,
  useCanvasConnect,
  useCanvasDrop,
} from "./hooks";

const proOptions: ProOptions = { hideAttribution: true };
const defaultEdgeOptions: DefaultEdgeOptions = {
  type: "default",
};

const nodeTypes = new Proxy(
  {
    group: GroupNode,
  },
  {
    get(target, prop) {
      if (typeof prop === "string") {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        return reactFlowNodeTypes[prop];
      }
      return undefined;
    },
    has(target, prop) {
      if (typeof prop === "string") {
        return prop in target || true;
      }
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      return Array.from(
        new Set([
          ...Reflect.ownKeys(target),
          ...Reflect.ownKeys(reactFlowNodeTypes),
        ]),
      );
    },
    getOwnPropertyDescriptor(target, prop) {
      return (
        Reflect.getOwnPropertyDescriptor(target, prop) ||
        Reflect.getOwnPropertyDescriptor(reactFlowNodeTypes, prop)
      );
    },
  },
) as any;

const edgeTypes = {
  default: ButtonEdge,
};

export function Canvas() {
  const nodesMap = useCanvasStore((s) => s.nodes);
  const edgesMap = useCanvasStore((s) => s.edges);
  const getEdges = useCallback(() => useCanvasStore.getState().edges, []);
  const setSelection = useUiStore((s) => s.setSelection);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const closeContextMenu = useUiStore((s) => s.closeContextMenu);
  const snapToGrid = useUiStore((s) => s.snapToGrid);
  const showMinimap = useUiStore((s) => s.showMinimap);
  const { getViewport, setCenter } = useReactFlow();

  const imageEditNodeId = useUiStore((s) => s.imageEditNodeId);
  const nodeInfoNodeId = useUiStore((s) => s.nodeInfoNodeId);

  const { isSpacePressed } = useCanvasKeyboard();
  const { onMoveEnd, onMove } = useCanvasViewport();
  const { onNodeDragStart, onNodesChange } = useCanvasDrag();
  const {
    connectMenu,
    onConnectStart,
    onConnect,
    onConnectEnd,
    onSelectConnectType,
  } = useCanvasConnect(nodesMap);
  const { onDragOver, onDrop } = useCanvasDrop();

  const rightClickStart = useRef<{ x: number; y: number } | null>(null);

  const selectedNodeIds = useUiStore((s) => s.selectedNodeIds);
  const storeViewport = useCanvasStore((s) => s.viewport);
  const activeNodeId = useUiStore((s) => s.activeNodeId);

  // 右键拖拽全局 capture：记录起点
  useEffect(() => {
    const handleGlobalMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        rightClickStart.current = { x: e.clientX, y: e.clientY };
      }
    };
    window.addEventListener("mousedown", handleGlobalMouseDown, true);
    return () =>
      window.removeEventListener("mousedown", handleGlobalMouseDown, true);
  }, []);

  // 右键 contextmenu：区分拖拽 vs 点击
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const rfContainer = target.closest(".react-flow");
      if (!rfContainer) return;

      if (rightClickStart.current) {
        const dx = Math.abs(e.clientX - rightClickStart.current.x);
        const dy = Math.abs(e.clientY - rightClickStart.current.y);
        rightClickStart.current = null;
        if (dx > 5 || dy > 5) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      const selectedIds = useUiStore.getState().selectedNodeIds;
      if (selectedIds.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu({ x: e.clientX, y: e.clientY, nodeId: null });
        return;
      }

      const isNode = target.closest(".react-flow__node");
      const isEdge = target.closest(".react-flow__edge");
      const isPane = target.closest(".react-flow__pane");
      const isSelection =
        target.closest(".react-flow__nodesselection") ||
        target.closest(".react-flow__nodesselection-rect");

      if (isNode || isEdge) return;

      if (isPane || isSelection) {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu({ x: e.clientX, y: e.clientY, nodeId: null });
      }
    };

    window.addEventListener("contextmenu", handleContextMenu, true);
    return () =>
      window.removeEventListener("contextmenu", handleContextMenu, true);
  }, [openContextMenu]);

  const selectedNodes = useMemo(() => {
    return Object.values(nodesMap).filter((n) =>
      selectedNodeIds.includes(n.id),
    );
  }, [nodesMap, selectedNodeIds]);

  const associatedGroupIds = useMemo<string[]>(() => {
    const gids = new Set<string>();
    for (const n of selectedNodes) {
      if (n.type === "group") {
        gids.add(n.id);
      } else if (n.parentId) {
        gids.add(n.parentId);
      }
    }
    return Array.from(gids);
  }, [selectedNodes]);

  const selectionToolbarStyle = useMemo<CSSProperties | null>(() => {
    const isSingleGroup =
      selectedNodes.length === 1 && selectedNodes[0].type === "group";
    if (selectedNodes.length < 2 && !isSingleGroup) return null;

    const xs = selectedNodes.map((n) => n.x);
    const ys = selectedNodes.map((n) => n.y);
    const xMaxs = selectedNodes.map((n) => n.x + (n.w || 240));

    const minX = Math.min(...xs);
    const maxX = Math.max(...xMaxs);
    const minY = Math.min(...ys);

    try {
      const vp = getViewport();
      const screenX = minX * vp.zoom + vp.x + ((maxX - minX) * vp.zoom) / 2;
      const screenY = minY * vp.zoom + vp.y;

      return {
        position: "absolute",
        left: screenX,
        top: screenY - 14,
        transform: "translate(-50%, -100%)",
        zIndex: 9999,
        pointerEvents: "auto",
      };
    } catch {
      return null;
    }
  }, [selectedNodes, storeViewport, getViewport]);

  const onGroupSelected = useCallback(() => {
    dispatchCommand({ type: "group", nodeIds: selectedNodeIds });
  }, [selectedNodeIds]);

  const onDeleteSelectedNodes = useCallback(() => {
    selectedNodeIds.forEach((id) => {
      dispatchCommand({ type: "deleteNode", id });
    });
    useUiStore.getState().setSelection([]);
  }, [selectedNodeIds]);

  const onUngroupSelected = useCallback(() => {
    associatedGroupIds.forEach((gid) => {
      dispatchCommand({ type: "ungroup", groupId: gid });
    });
    useUiStore.getState().setSelection([]);
  }, [associatedGroupIds]);

  const rfNodes = useMemo<Node[]>(() => {
    // 视口裁剪：只渲染视口 ± 280px padding 范围内的节点
    const vp = storeViewport;
    const PADDING = 280;
    const zoom = vp.zoom || 0.7;
    // 将 ReactFlow 容器像素近似为 1920x1080（仅影响大画布过滤）
    const containerW = window.innerWidth / zoom;
    const containerH = window.innerHeight / zoom;
    const vpLeft = -vp.x / zoom;
    const vpTop = -vp.y / zoom;
    const vpRight = vpLeft + containerW;
    const vpBottom = vpTop + containerH;

    const sorted = Object.values(nodesMap)
      .filter((n) => {
        if (n.type === "group") return true; // 组节点始终保留
        const nw = n.w || 240;
        const nh = n.h || 200;
        return (
          n.x + nw >= vpLeft - PADDING &&
          n.x <= vpRight + PADDING &&
          n.y + nh >= vpTop - PADDING &&
          n.y <= vpBottom + PADDING
        );
      })
      .map((n) => {
        const isGroup = n.type === "group";
        return {
          id: n.id,
          type: n.type,
          position: { x: n.x, y: n.y },
          style: {
            width: n.w,
            height: n.h,
            zIndex: isGroup ? -100 : activeNodeId === n.id ? 10000 : 1,
          },
          data: { nodeId: n.id },
          parentId: undefined,
          extent: undefined,
        };
      });
    return sorted.sort((a, b) => {
      if (a.type === "group" && b.type !== "group") return -1;
      if (a.type !== "group" && b.type === "group") return 1;
      return 0;
    });
  }, [nodesMap, activeNodeId, storeViewport]);

  const rfEdges = useMemo<Edge[]>(
    () =>
      Object.values(edgesMap).map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourcePort,
        targetHandle: e.targetPort,
        animated: e.kind === "continuation",
      })),
    [edgesMap],
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const selectedIds = useUiStore.getState().selectedNodeIds;
      if (selectedIds.length <= 1) {
        useUiStore.getState().setActiveNodeId(node.id);
        const storeNode = useCanvasStore.getState().nodes[node.id];
        if (storeNode) {
          const centerX = storeNode.x + (storeNode.w || 240) / 2;
          const centerY = storeNode.y + (storeNode.h || 200) / 2;
          const { zoom } = getViewport();
          // Shift viewport center down by 1/4 of window height, so the node moves up to 1/4 from the top of the screen (3/4 space below)
          const offsetY = (window.innerHeight * 0.1) / zoom;
          setCenter(centerX, centerY + offsetY, { zoom, duration: 400 });
        }
      }
    },
    [setCenter, getViewport],
  );

  const onSelectionChange = useCallback(
    (params: OnSelectionChangeParams) => {
      const selectedIds = params.nodes.map((n) => n.id);
      setSelection(selectedIds);
      if (selectedIds.length === 1) {
        useUiStore.getState().setActiveNodeId(selectedIds[0]);
      } else {
        useUiStore.getState().setActiveNodeId(null);
      }
    },
    [setSelection],
  );

  const onMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const isPane =
        target.classList.contains("react-flow__pane") ||
        target.closest(".react-flow__pane");
      const isNode = target.closest(".react-flow__node");
      const isEdge = target.closest(".react-flow__edge");
      if (!isPane || isNode || isEdge) return;

      if (useUiStore.getState().contextMenu) {
        closeContextMenu();
      }
    },
    [closeContextMenu],
  );

  const onNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: Node) => {
      e.preventDefault();
      if (rightClickStart.current) {
        const dx = Math.abs(e.clientX - rightClickStart.current.x);
        const dy = Math.abs(e.clientY - rightClickStart.current.y);
        rightClickStart.current = null;
        if (dx > 5 || dy > 5) return;
      }
      openContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
    },
    [openContextMenu],
  );

  const onEdgeContextMenu = useCallback(
    (e: ReactMouseEvent, edge: Edge) => {
      e.preventDefault();
      if (rightClickStart.current) {
        const dx = Math.abs(e.clientX - rightClickStart.current.x);
        const dy = Math.abs(e.clientY - rightClickStart.current.y);
        rightClickStart.current = null;
        if (dx > 5 || dy > 5) return;
      }
      openContextMenu({
        x: e.clientX,
        y: e.clientY,
        nodeId: null,
        edgeId: edge.id,
      });
    },
    [openContextMenu],
  );

  const onPaneClick = useCallback(() => {
    closeContextMenu();
    useUiStore.getState().setActiveNodeId(null);
  }, [closeContextMenu]);

  const isValidConnection = useMemo(
    () => makeIsValidConnection(getEdges),
    [getEdges],
  );

  return (
    <div className="relative w-full h-full">
      <ReactFlow
        className="Qiji-flow"
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onSelectionChange={onSelectionChange}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneClick={onPaneClick}
        onMouseDown={onMouseDown}
        onNodeClick={onNodeClick}
        onNodeDragStart={onNodeDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        isValidConnection={isValidConnection}
        proOptions={proOptions}
        defaultEdgeOptions={defaultEdgeOptions}
        minZoom={0.05}
        maxZoom={50}
        snapToGrid={snapToGrid}
        snapGrid={[15, 15]}
        onMoveEnd={onMoveEnd}
        onMove={onMove}
        panOnDrag={isSpacePressed ? [0, 2] : [2]}
        selectionOnDrag={!isSpacePressed}
        selectionMode={SelectionMode.Partial}
        selectionKeyCode={null}
        zoomOnScroll={true}
        panOnScroll={false}
        zoomActivationKeyCode={null}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={15}
          size={1.2}
          color="rgba(255,255,255,0.08)"
        />

        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>

      {showMinimap && (
        <div
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            zIndex: 10,
            pointerEvents: "auto",
          }}
        >
          <MiniMapCustom />
        </div>
      )}

      {connectMenu && (
        <div
          style={{
            position: "fixed",
            left: connectMenu.x,
            top: connectMenu.y,
            transform: "translate(-50%, 0)",
          }}
          className="Qiji-panel pointer-events-auto z-[10300] flex flex-col gap-0.5 rounded-xl p-1 shadow-2xl w-32 text-[11px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2 py-1 text-muted-foreground font-semibold text-[9px] uppercase border-b border-border/40 mb-1 select-none">
            连线生成节点
          </div>
          {listPlugins()
            .filter((p) => !p.type.startsWith("file_"))
            .map((plugin) => {
              const Icon = plugin.icon;
              return (
                <button
                  key={plugin.type}
                  onClick={() => onSelectConnectType(plugin.type)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-foreground hover:bg-secondary transition-colors cursor-pointer"
                >
                  <Icon className="h-3.5 w-3.5" />
                  {plugin.label}
                </button>
              );
            })}
        </div>
      )}

      <AnimatePresence>
        {activeNodeId &&
          (() => {
            const node = useCanvasStore.getState().nodes[activeNodeId];
            if (node?.type === "video") {
              return (
                <VideoOperationPanel nodeId={activeNodeId} key={activeNodeId} />
              );
            }
            return <OperationPanel nodeId={activeNodeId} key={activeNodeId} />;
          })()}
      </AnimatePresence>

      {selectionToolbarStyle && (
        <div
          style={selectionToolbarStyle}
          className="Qiji-panel pointer-events-auto z-[10250] flex items-center gap-1 rounded-xl p-1 shadow-2xl border border-white/10 text-xs text-foreground select-none"
        >
          {selectedNodes.length >= 2 && (
            <>
              <button
                onClick={onGroupSelected}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-secondary cursor-pointer transition-colors font-medium text-[11px]"
              >
                <Combine className="h-3.5 w-3.5 text-primary" />
                <span>合并打组</span>
              </button>
              <div className="h-4 w-[1px] bg-border/40" />
            </>
          )}
          {associatedGroupIds.length > 0 && (
            <>
              <button
                onClick={onUngroupSelected}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-orange-400 hover:bg-secondary cursor-pointer transition-colors font-medium text-[11px]"
              >
                <Ungroup className="h-3.5 w-3.5" />
                <span>解除打组</span>
              </button>
              <div className="h-4 w-[1px] bg-border/40" />
            </>
          )}
          <button
            onClick={onDeleteSelectedNodes}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-destructive hover:bg-secondary cursor-pointer transition-colors font-medium text-[11px]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>删除</span>
          </button>
        </div>
      )}

      {imageEditNodeId && (
        <div
          className="fixed inset-0 z-[20000] flex items-center justify-center"
          onClick={() => useUiStore.getState().setImageEditNodeId(null)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <ImageEditPanel
              nodeId={imageEditNodeId}
              onClose={() => useUiStore.getState().setImageEditNodeId(null)}
            />
          </div>
        </div>
      )}

      {nodeInfoNodeId && <NodeInfoPopover />}
    </div>
  );
}
