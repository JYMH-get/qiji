import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  CSSProperties,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type Connection,
  type DefaultEdgeOptions,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
  type ProOptions,
} from "@xyflow/react";
import { MiniMapCustom } from "./MiniMapCustom";
import { getPlugin, listPlugins } from "@/nodes/pluginRegistry";
import { reactFlowNodeTypes } from "@/nodes/registry";
import { GroupNode } from "@/nodes/GroupNode";
import { ButtonEdge } from "./ButtonEdge";
import { makeIsValidConnection } from "@/dag/validate";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { useProjectStore } from "@/store/projectStore";
import { dispatchCommand } from "@/command/dispatch";
import { genId } from "@/lib/id";
import { makeNode } from "./nodeFactory";
import type { NodeType } from "@/types";
import { storeDroppedFile } from "@/services/fileStorage";
import { useLibraryStore } from "@/store/libraryStore";
import { AnimatePresence } from "motion/react";
import { OperationPanel } from "@/panel/OperationPanel";
import { Combine, Trash2, Ungroup } from "lucide-react";

const proOptions: ProOptions = { hideAttribution: true };
const defaultEdgeOptions: DefaultEdgeOptions = {
  type: "default",
};

const nodeTypes = {
  ...reactFlowNodeTypes,
  group: GroupNode,
};

const edgeTypes = {
  default: ButtonEdge,
};

const getGroupRelatedNodeIds = (
  nodeId: string,
  nodesMap: Record<string, any>,
) => {
  const node = nodesMap[nodeId];
  if (!node) return [nodeId];

  let groupId: string | null = null;
  if (node.type === "group") {
    groupId = node.id;
  } else if (node.parentId) {
    groupId = node.parentId;
  }

  if (!groupId) return [nodeId];

  const related = [groupId];
  for (const n of Object.values(nodesMap)) {
    if (n.parentId === groupId) {
      related.push(n.id);
    }
  }
  return Array.from(new Set(related));
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
  const { screenToFlowPosition, getViewport, setViewport, fitView, setCenter } =
    useReactFlow();

  const isProjectLoading = useProjectStore((s) => s.isProjectLoading);
  const savePath = useProjectStore((s) => s.savePath);

  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const dragStartPositions = useRef<Record<string, { x: number; y: number }>>(
    {},
  );
  const rightClickStart = useRef<{ x: number; y: number } | null>(null);

  // 同步 ReactFlow 视口至 CanvasStore
  const onMoveEnd = useCallback(() => {
    useCanvasStore.getState().setViewport(getViewport());
  }, [getViewport]);

  const onMove = useCallback((_event: any, viewport: any) => {
    useCanvasStore.getState().setViewport(viewport);
  }, []);

  // 当项目加载完毕或项目路径变化时恢复视口
  useEffect(() => {
    if (!isProjectLoading) {
      const storeVp = useCanvasStore.getState().viewport;
      const currentVp = getViewport();

      const hasSavedViewport =
        storeVp && (storeVp.x !== 0 || storeVp.y !== 0 || storeVp.zoom !== 0.7);

      if (hasSavedViewport) {
        if (
          Math.abs(storeVp.x - currentVp.x) > 0.1 ||
          Math.abs(storeVp.y - currentVp.y) > 0.1 ||
          Math.abs(storeVp.zoom - currentVp.zoom) > 0.01
        ) {
          setViewport(storeVp);
        }
      } else {
        setViewport({ x: 0, y: 0, zoom: 0.7 });
      }
    }
  }, [isProjectLoading, savePath, setViewport, getViewport, fitView]);

  const connectStartRef = useRef<{
    nodeId: string;
    handleId: string | null;
    handleType: "source" | "target";
  } | null>(null);
  const connectionMadeRef = useRef(false);

  const [connectMenu, setConnectMenu] = useState<{
    x: number;
    y: number;
    flowX: number;
    flowY: number;
  } | null>(null);

  // 键盘快捷键：Ctrl+Z 撤销，Ctrl+Y 重做，Ctrl+G 打组
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      if (isCtrl && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatchCommand({ type: "undo" });
      } else if (isCtrl && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatchCommand({ type: "redo" });
      } else if (isCtrl && e.key.toLowerCase() === "g") {
        const selectedIds = useUiStore.getState().selectedNodeIds;
        if (selectedIds.length > 1) {
          e.preventDefault();
          dispatchCommand({ type: "group", nodeIds: selectedIds });
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 键盘监听：空格长按拖动画布（如果在输入框/文本域则不触发）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        const activeEl = document.activeElement;
        const isInput =
          activeEl &&
          (activeEl.tagName === "INPUT" ||
            activeEl.tagName === "TEXTAREA" ||
            activeEl.getAttribute("contenteditable") === "true");
        if (!isInput) {
          e.preventDefault();
          setIsSpacePressed(true);
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpacePressed(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  const selectedNodeIds = useUiStore((s) => s.selectedNodeIds);
  const storeViewport = useCanvasStore((s) => s.viewport);

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

  // Global listener to record right click start position for drag/click distinction,
  // using capture phase to prevent React Flow's event propagation blocking.
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

  // Intercept right-clicks on selection bounding box, pane, or anywhere inside the canvas
  // to distinguish right-click dragging from clicking, using capture phase.
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const rfContainer = target.closest(".react-flow");
      if (!rfContainer) return;

      // 1. Drag detection for right-click pan
      if (rightClickStart.current) {
        const dx = Math.abs(e.clientX - rightClickStart.current.x);
        const dy = Math.abs(e.clientY - rightClickStart.current.y);
        rightClickStart.current = null; // Clear it
        if (dx > 5 || dy > 5) {
          // Dragged to pan, prevent default context menu, do not open custom menu
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // 2. Check if we have multiple nodes selected
      const selectedIds = useUiStore.getState().selectedNodeIds;
      if (selectedIds.length > 1) {
        // Multi-selection: show selection context menu on right click anywhere in react-flow
        e.preventDefault();
        e.stopPropagation();
        openContextMenu({ x: e.clientX, y: e.clientY, nodeId: null });
        return;
      }

      // 3. Single selection or no selection: identify target areas
      const isNode = target.closest(".react-flow__node");
      const isEdge = target.closest(".react-flow__edge");
      const isPane = target.closest(".react-flow__pane");
      const isSelection =
        target.closest(".react-flow__nodesselection") ||
        target.closest(".react-flow__nodesselection-rect");

      if (isNode || isEdge) {
        // Let React Flow's custom handlers (onNodeContextMenu / onEdgeContextMenu) handle it
        return;
      }

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

  // 点击其他区域关闭连线菜单
  useEffect(() => {
    if (!connectMenu) return;
    const close = () => setConnectMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [connectMenu]);

  const activeNodeId = useUiStore((s) => s.activeNodeId);
  const rfNodes = useMemo<Node[]>(() => {
    const sorted = Object.values(nodesMap).map((n) => {
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
        parentId: undefined, // Keep coords absolute relative to canvas instead of parent group
        extent: undefined,
      };
    });
    // Sort group nodes to the beginning so they render behind other nodes
    return sorted.sort((a, b) => {
      if (a.type === "group" && b.type !== "group") return -1;
      if (a.type !== "group" && b.type === "group") return 1;
      return 0;
    });
  }, [nodesMap, activeNodeId]);

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

  const onNodeDragStart = useCallback(
    (_event: any, _node: Node, nodes: Node[]) => {
      const storeNodes = useCanvasStore.getState().nodes;
      for (const n of nodes) {
        const sNode = storeNodes[n.id];
        if (sNode) {
          if (sNode.type === "group") {
            const relatedIds = getGroupRelatedNodeIds(n.id, storeNodes);
            for (const rid of relatedIds) {
              const current = storeNodes[rid];
              if (current) {
                dragStartPositions.current[rid] = {
                  x: current.x,
                  y: current.y,
                };
              }
            }
          } else {
            dragStartPositions.current[n.id] = { x: sNode.x, y: sNode.y };
          }
        }
      }
    },
    [],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const store = useCanvasStore.getState();
    let hasDragEnd = false;

    const dragUpdates: Record<string, { x: number; y: number }> = {};

    for (const ch of changes) {
      if (ch.type === "position" && ch.position) {
        if (ch.dragging) {
          const startPos = dragStartPositions.current[ch.id];
          if (startPos) {
            const dx = ch.position.x - startPos.x;
            const dy = ch.position.y - startPos.y;

            const sNode = store.nodes[ch.id];
            if (sNode && sNode.type === "group") {
              const relatedIds = getGroupRelatedNodeIds(ch.id, store.nodes);
              for (const rid of relatedIds) {
                const rStart = dragStartPositions.current[rid];
                if (rStart) {
                  dragUpdates[rid] = {
                    x: rStart.x + dx,
                    y: rStart.y + dy,
                  };
                }
              }
            } else {
              dragUpdates[ch.id] = {
                x: startPos.x + dx,
                y: startPos.y + dy,
              };
            }
          } else {
            dragUpdates[ch.id] = { x: ch.position.x, y: ch.position.y };
          }
        } else {
          hasDragEnd = true;
        }
      }
    }

    for (const [id, pos] of Object.entries(dragUpdates)) {
      store.moveNode(id, pos.x, pos.y);
    }

    // Recalculate group bounds in real-time
    const syncGroupBounds = (nodeIds: string[]) => {
      const groupsToUpdate = new Set<string>();
      const currentNodes = useCanvasStore.getState().nodes;
      for (const id of nodeIds) {
        const node = currentNodes[id];
        if (node && node.parentId) {
          groupsToUpdate.add(node.parentId);
        }
      }

      if (groupsToUpdate.size > 0) {
        const updatedNodes = { ...currentNodes };
        const updatedGroups = { ...useCanvasStore.getState().groups };

        for (const groupId of groupsToUpdate) {
          const group = updatedGroups[groupId];
          if (!group) continue;

          const remainingNodes = group.childIds
            .map((id) => updatedNodes[id])
            .filter(Boolean);
          if (remainingNodes.length > 0) {
            const xs = remainingNodes.map((n) => n.x);
            const ys = remainingNodes.map((n) => n.y);
            const xMaxs = remainingNodes.map((n) => n.x + (n.w || 240));
            const yMaxs = remainingNodes.map((n) => n.y + (n.h || 200));

            const minX = Math.min(...xs);
            const maxX = Math.max(...xMaxs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...yMaxs);
            const paddingLeft = 20;
            const paddingRight = 20;
            const paddingBottom = 20;
            const paddingTop = 40;
            const groupX = minX - paddingLeft;
            const groupY = minY - paddingTop;
            const groupW = maxX - minX + paddingLeft + paddingRight;
            const groupH = maxY - minY + paddingTop + paddingBottom;

            if (updatedNodes[groupId]) {
              updatedNodes[groupId] = {
                ...updatedNodes[groupId],
                x: groupX,
                y: groupY,
                w: groupW,
                h: groupH,
              };
            }

            updatedGroups[groupId] = {
              ...group,
              x: groupX,
              y: groupY,
            };
          }
        }

        useCanvasStore.setState({
          nodes: updatedNodes,
          groups: updatedGroups,
        });
      }
    };

    syncGroupBounds(Object.keys(dragUpdates));

    if (hasDragEnd) {
      const dragEnds: {
        id: string;
        x: number;
        y: number;
        startX: number;
        startY: number;
      }[] = [];
      for (const ch of changes) {
        if (ch.type === "position" && ch.position && ch.dragging === false) {
          const startPos = dragStartPositions.current[ch.id];
          if (startPos) {
            const dx = ch.position.x - startPos.x;
            const dy = ch.position.y - startPos.y;

            const sNode = store.nodes[ch.id];
            if (sNode && sNode.type === "group") {
              const relatedIds = getGroupRelatedNodeIds(ch.id, store.nodes);
              for (const rid of relatedIds) {
                const rStart = dragStartPositions.current[rid];
                if (rStart) {
                  dragEnds.push({
                    id: rid,
                    x: rStart.x + dx,
                    y: rStart.y + dy,
                    startX: rStart.x,
                    startY: rStart.y,
                  });
                }
              }
            } else {
              dragEnds.push({
                id: ch.id,
                x: startPos.x + dx,
                y: startPos.y + dy,
                startX: startPos.x,
                startY: startPos.y,
              });
            }
          }
        }
      }

      if (dragEnds.length > 0) {
        const uniqueEndsMap: Record<string, (typeof dragEnds)[0]> = {};
        for (const item of dragEnds) {
          uniqueEndsMap[item.id] = item;
        }
        const uniqueEnds = Object.values(uniqueEndsMap);

        // 1. 先将需要结束拖拽的节点还原到拖拽前坐标，以确保 pushHistory 时存入拖拽前的状态
        for (const item of uniqueEnds) {
          store.moveNode(item.id, item.startX, item.startY);
        }
        // Revert group bounds based on start coordinates
        syncGroupBounds(uniqueEnds.map((item) => item.id));

        // 2. 派发正式的批量位置更新指令，这会由 CommandBus 自动 pushHistory，然后再将它们设置到最终坐标
        dispatchCommand({
          type: "updateNodePosition",
          updates: uniqueEnds.map((item) => ({
            id: item.id,
            x: item.x,
            y: item.y,
          })),
        });

        // 3. 清理已结束节点的拖拽起点位置
        for (const item of uniqueEnds) {
          delete dragStartPositions.current[item.id];
        }
      }
    }
  }, []);

  const onNodeClick = useCallback(
    (_event: any, node: Node) => {
      const selectedIds = useUiStore.getState().selectedNodeIds;
      if (selectedIds.length <= 1) {
        useUiStore.getState().setActiveNodeId(node.id);
        const storeNode = useCanvasStore.getState().nodes[node.id];
        if (storeNode) {
          const centerX = storeNode.x + (storeNode.w || 240) / 2;
          const centerY = storeNode.y + (storeNode.h || 200) / 2;
          const { zoom } = getViewport();
          setCenter(centerX, centerY, { zoom, duration: 400 });
        }
      }
    },
    [setCenter, getViewport],
  );

  const onConnectStart = useCallback((_event: any, params: any) => {
    connectStartRef.current = {
      nodeId: params.nodeId,
      handleId: params.handleId,
      handleType: params.handleType,
    };
    connectionMadeRef.current = false;
  }, []);

  const onConnect = useCallback((conn: Connection) => {
    connectionMadeRef.current = true;
    if (!conn.source || !conn.target) return;
    dispatchCommand({
      type: "connect",
      edge: {
        id: genId("edge"),
        kind: "dataflow",
        source: conn.source,
        sourcePort: conn.sourceHandle ?? "out",
        target: conn.target,
        targetPort: conn.targetHandle ?? "in",
      },
    });
  }, []);

  const onConnectEnd = useCallback(
    (event: any) => {
      if (connectionMadeRef.current || !connectStartRef.current) return;

      const target = event.target as HTMLElement;
      const isPane =
        target.classList.contains("react-flow__pane") ||
        target.closest(".react-flow__pane");
      if (!isPane) return;

      const clientX =
        event.clientX || (event.touches && event.touches[0]?.clientX);
      const clientY =
        event.clientY || (event.touches && event.touches[0]?.clientY);

      if (clientX === undefined || clientY === undefined) return;

      const flowPos = screenToFlowPosition({ x: clientX, y: clientY });

      setConnectMenu({
        x: clientX,
        y: clientY,
        flowX: flowPos.x,
        flowY: flowPos.y,
      });
    },
    [screenToFlowPosition],
  );

  const onSelectConnectType = (type: NodeType) => {
    if (!connectStartRef.current || !connectMenu) return;

    const { nodeId, handleId, handleType } = connectStartRef.current;
    const newNode = makeNode(type, connectMenu.flowX, connectMenu.flowY);

    // If source node is inside a group, add the new node to the same group
    const sourceNode = nodesMap[nodeId];
    if (sourceNode?.parentId) {
      newNode.parentId = sourceNode.parentId;
    }

    // 1. 创建节点
    dispatchCommand({ type: "addNode", node: newNode });

    // 2. 补齐对应连线
    const def = getPlugin(type);
    if (def) {
      if (handleType === "source") {
        const targetPort = def.inputs[0]?.name;
        if (targetPort) {
          dispatchCommand({
            type: "connect",
            edge: {
              id: genId("edge"),
              kind: "dataflow",
              source: nodeId,
              sourcePort: handleId ?? "out",
              target: newNode.id,
              targetPort,
            },
          });
        }
      } else {
        const sourcePort = def.outputs[0]?.name;
        if (sourcePort) {
          dispatchCommand({
            type: "connect",
            edge: {
              id: genId("edge"),
              kind: "dataflow",
              source: newNode.id,
              sourcePort,
              target: nodeId,
              targetPort: handleId ?? "in",
            },
          });
        }
      }
    }

    setConnectMenu(null);
    connectStartRef.current = null;
  };

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
      // Disable middle click (button === 1) autoscroll
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

  const onDragOver = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      e.preventDefault();
      const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });

      // 1. Check if files are dropped from OS filesystem
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = Array.from(e.dataTransfer.files);
        let offsetY = 0;
        for (const file of files) {
          let kind: "image" | "video" | "audio" | "script" | null = null;
          if (file.type.startsWith("image/")) {
            kind = "image";
          } else if (file.type.startsWith("video/")) {
            kind = "video";
          } else if (file.type.startsWith("audio/")) {
            kind = "audio";
          } else if (
            file.name.endsWith(".txt") ||
            file.name.endsWith(".doc") ||
            file.name.endsWith(".docx") ||
            file.name.endsWith(".pdf") ||
            file.name.endsWith(".json")
          ) {
            kind = "script";
          }

          if (kind) {
            // Process upload
            (async () => {
              const stored = await storeDroppedFile(file);
              if (!stored) return;
              const assetId = stored.fileId;

              useLibraryStore.getState().addAsset({
                id: assetId,
                kind,
                name: stored.fileName,
                uri: stored.fileUri,
                thumbnailUri: null,
                createdAt: new Date().toISOString(),
                deletedByUser: false,
                localPath: stored.localPath,
              });

              const nodeType = `file_${kind === "script" ? "document" : kind}`;
              const newNode = makeNode(nodeType, pos.x, pos.y + offsetY);
              newNode.data.resultAssetId = assetId;

              dispatchCommand({ type: "addNode", node: newNode });
            })();
            offsetY += 240; // Space out multiple nodes vertically
          }
        }
        return;
      }

      const dragData = e.dataTransfer.getData("text/plain");
      if (!dragData) return;

      // 2. Check if it's an asset library drag
      try {
        if (dragData.startsWith("{") && dragData.includes("library")) {
          const data = JSON.parse(dragData);
          if (data.source === "library") {
            const kind = data.kind; // "image" | "video" | "audio" | "script"
            const nodeType = `file_${kind === "script" ? "document" : kind}`;
            if (getPlugin(nodeType)) {
              const newNode = makeNode(nodeType, pos.x, pos.y);
              newNode.data.resultAssetId = data.assetId;
              dispatchCommand({ type: "addNode", node: newNode });
            }
            return;
          }
        }
      } catch (err) {
        console.error("Failed to parse drop JSON data", err);
      }

      // 3. Sidebar drag fallback
      const type = dragData as NodeType;
      if (getPlugin(type)) {
        dispatchCommand({
          type: "addNode",
          node: makeNode(type, pos.x, pos.y),
        });
      }
    },
    [screenToFlowPosition],
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

      {/* 完全自定义小地图，放在 ReactFlow 外部避免 transform 干扰 */}
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
          className="Qiji-panel pointer-events-auto z-50 flex flex-col gap-0.5 rounded-xl p-1 shadow-2xl w-32 text-[11px]"
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
        {activeNodeId && (
          <OperationPanel nodeId={activeNodeId} key={activeNodeId} />
        )}
      </AnimatePresence>

      {selectionToolbarStyle && (
        <div
          style={selectionToolbarStyle}
          className="Qiji-panel pointer-events-auto z-[9999] flex items-center gap-1 rounded-xl p-1 shadow-2xl border border-white/10 text-xs text-foreground select-none"
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
    </div>
  );
}
