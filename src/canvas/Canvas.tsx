import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, CSSProperties } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  ReactFlow,
  useReactFlow,
  useStoreApi,
  SelectionMode,
  type DefaultEdgeOptions,
  type Edge,
  type Node,
  type OnSelectionChangeParams,
  type ProOptions,
} from "@xyflow/react";
import { MiniMapCustom } from "./MiniMapCustom";
import { MultiConnectionLine } from "./MultiConnectionLine";
import { SnapGuideLines } from "./SnapGuideLines";
import { NodeCountWarnToast } from "./NodeCountWarnToast";
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
import { ChatPanel } from "@/panel/ChatPanel";
import { SimplePanel } from "@/panel/SimplePanel";
import { getPlugin } from "@/nodes/pluginRegistry";
import { Combine, Trash2, Ungroup, Play, Sparkles, Network, LayoutGrid, ShieldCheck, Palette } from "lucide-react";
import { listPresetSchemes } from "@/lib/presetSchemes";
import { imageNodeCount, addPresetToNodes, checkNodesAssets } from "@/canvas/multiSelectOps";
import { ImageEditPanel } from "@/panel/ImageEditPanel";
import { NodeProcessModals } from "@/canvas/NodeProcessModals";
import { NodeInfoPopover } from "@/nodes/NodeInfoModal";
import { tidyLayout, mapEdgesToUnits } from "@/lib/tidyLayout";
import { useSettingsStore } from "@/store/settingsStore";
import { pickEdgesInRect } from "@/lib/edgePick";
import type { CanvasNode, CanvasEdge } from "@/types";
import {
  useCanvasKeyboard,
  useCanvasViewport,
  useCanvasDrag,
  useCanvasConnect,
  useCanvasDrop,
  useCanvasPaste,
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

/**
 * 文本主干整理增高：支线(下游分支)越多越高；封顶到「能显示全部文字」的高度，且不低于默认 200。
 * 高度估算按节点内文本量 + 列宽粗算行数（10px 字号、CJK 偏宽，宁可略高以容下全文）。
 */
function trunkTextHeight(node: CanvasNode, branches: number): number {
  const w = node.w ?? 240;
  const text = String(
    (node.data?.params?.prompt as string | undefined) ??
      (typeof node.data?.resultText === "string" ? node.data.resultText : "") ??
      "",
  );
  const charsPerLine = Math.max(8, Math.floor((w - 20) / 9));
  const lines = text.length
    ? text.split("\n").reduce((acc, ln) => acc + Math.max(1, Math.ceil(ln.length / charsPerLine)), 0)
    : 0;
  const fullTextH = lines ? Math.ceil(lines * 15 + 24) : 200;
  const byBranch = 200 + branches * 60; // 支线越多越高（始终短于其分支纵向跨度，避免压到分支）
  return Math.max(200, Math.min(byBranch, Math.max(fullTextH, 200)));
}

export function Canvas() {
  const nodesMap = useCanvasStore((s) => s.nodes);
  const edgesMap = useCanvasStore((s) => s.edges);
  const getEdges = useCallback(() => useCanvasStore.getState().edges, []);
  const setSelection = useUiStore((s) => s.setSelection);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const closeContextMenu = useUiStore((s) => s.closeContextMenu);
  const showGrid = useUiStore((s) => s.showGrid);
  const showMinimap = useUiStore((s) => s.showMinimap);
  const { getViewport, setCenter, fitView, screenToFlowPosition } = useReactFlow();
  const rfStoreApi = useStoreApi();

  const imageEditNodeId = useUiStore((s) => s.imageEditNodeId);
  const nodeInfoNodeId = useUiStore((s) => s.nodeInfoNodeId);

  const { isSpacePressed } = useCanvasKeyboard();
  useCanvasPaste(); // Ctrl+V 统一分流：内部节点克隆 / 系统剪贴板图片→上传节点 / 文字→文本节点
  const { onMoveStart, onMoveEnd, onMove } = useCanvasViewport();
  const { onNodeDragStart, onNodeDrag, onNodesChange } = useCanvasDrag();
  const {
    connectMenu,
    connectStartRef,
    onConnectStart,
    onConnect,
    onConnectEnd,
    onSelectConnectType,
  } = useCanvasConnect(nodesMap);
  const { onDragOver, onDrop } = useCanvasDrop();

  const rightClickStart = useRef<{ x: number; y: number } | null>(null);

  const selectedNodeIds = useUiStore((s) => s.selectedNodeIds);
  // 注意：Canvas 本体**不订阅 viewport**——onMove 每帧写 store，订阅它会让整个 Canvas 逐帧重渲染（平移卡顿）。
  // 需要跟随视口的 UI（多选工具栏）拆成独立小组件 SelectionToolbar 自己订阅。
  const activeNodeId = useUiStore((s) => s.activeNodeId);
  // 堆叠抽屉开着的节点提到最上层（抽屉锚在节点右侧，别被相邻节点盖住）；开关低频，订阅无性能负担
  const stackDrawerNodeId = useUiStore((s) => s.stackDrawerNodeId);

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

  // 整理画布（拼图式，第121轮）：连通的一片节点=一个族群方块（内部按思维导图整理），
  // 族群之间按最优拼图打包（趋向 1:1 方形、间隙=1.5×节点间距、尽量保持原相对方位）。
  // 分组容器凭组内子节点的对外连线跟随族群；孤立组=独立方块。
  // 一次 updateNodePosition 命令 = 一次撤销；布局后 fitView 平滑居中框选全图。
  const tidyMindmap = useCallback(() => {
    const s = useCanvasStore.getState();
    const allNodes = Object.values(s.nodes);
    const topNodes = allNodes.filter((n) => n.type !== "group" && !n.parentId);
    const groupNodes = allNodes.filter((n) => n.type === "group");
    if (topNodes.length + groupNodes.length === 0) return;

    // 每个节点的下游分支数（用于文本主干增高）
    const childCount = new Map<string, number>();
    for (const e of Object.values(s.edges)) {
      childCount.set(e.source, (childCount.get(e.source) ?? 0) + 1);
    }

    // 先定各节点整理后的目标尺寸，再喂给布局——布局按**最终**宽高占位（先排位后改高会重新重叠）：
    // - 资产拆分节点：结果是优化后的统计面板，不随输出文字长度变高 → 整理恒定 400 高（统计卡+视觉圣经完整可见，用户实测定档）；
    // - 其它文本主干：支线越多越高（封顶到「显示全部文字」的高度），增强观感。
    const sizeOverride = new Map<string, { w: number; h: number }>();
    for (const node of topNodes) {
      if (node.type === "asset.split") {
        if (Math.abs((node.h ?? 200) - 400) > 1) sizeOverride.set(node.id, { w: node.w ?? 240, h: 400 });
        continue;
      }
      const plugin = getPlugin(node.type);
      const branches = childCount.get(node.id) ?? 0;
      if (plugin?.displayKind === "text" && branches >= 3) {
        const newH = trunkTextHeight(node, branches);
        if (Math.abs(newH - (node.h ?? 200)) > 4) sizeOverride.set(node.id, { w: node.w ?? 240, h: newH });
      }
    }

    const layoutInput = [...topNodes, ...groupNodes].map((n) => {
      const ov = sizeOverride.get(n.id);
      return ov ? { ...n, w: ov.w, h: ov.h } : n;
    });
    // 组内子节点的对外连线映射到容器名下（组对外有连线=跟随该族群拼图）
    const unitIds = new Set(layoutInput.map((n) => n.id));
    const ownerOf = (id: string): string | undefined => {
      const n = s.nodes[id];
      if (!n) return undefined;
      const owner = n.parentId && s.nodes[n.parentId] ? n.parentId : id;
      return unitIds.has(owner) ? owner : undefined;
    };
    // 纵向节点间距（高度方向）用户可在 设置→快捷键 页自定义（tidyRowGap，随 settings.json 持久化）
    const layout = tidyLayout(layoutInput, mapEdgesToUnits(Object.values(s.edges), ownerOf), {
      rowGap: useSettingsStore.getState().tidyRowGap,
    });

    const updates: { id: string; x: number; y: number; w?: number; h?: number }[] = [];
    for (const l of layout) {
      const node = s.nodes[l.id];
      if (!node) continue;
      const nx = Math.round(l.x);
      const ny = Math.round(l.y);
      if (node.type === "group") {
        // 分组整体平移：容器 + 全部子节点同步移动（内部相对布局不变）
        const dx = nx - node.x;
        const dy = ny - node.y;
        updates.push({ id: node.id, x: nx, y: ny });
        for (const child of allNodes) {
          if (child.parentId === node.id) updates.push({ id: child.id, x: child.x + dx, y: child.y + dy });
        }
        continue;
      }
      const upd: { id: string; x: number; y: number; w?: number; h?: number } = { id: l.id, x: nx, y: ny };
      const ov = sizeOverride.get(l.id);
      if (ov) {
        upd.w = ov.w;
        upd.h = ov.h;
      }
      updates.push(upd);
    }
    dispatchCommand({ type: "updateNodePosition", updates });
    setTimeout(() => fitView({ padding: 0.2, duration: 500 }), 60);
  }, [fitView]);

  // 渲染全部节点（不再按视口逐帧裁剪）：① 裁剪会让"不在同屏"的节点被移除→其连线消失(#5)；
  // ② 逐帧重算裁剪(依赖 viewport) 是平移卡顿主因(#6)。改为仅在节点/激活态变化时重算，平移/缩放由 React Flow 自身 transform。
  //
  // wrapper 引用缓存（性能关键）：拖动时 moveNode 每帧换 nodesMap 引用 → 本 memo 每帧重跑；
  // 若每次都为全部节点新建 wrapper 对象，会打破 React Flow 的节点 memo → 拖 1 个节点 = 全画布节点逐帧重渲染。
  // 按「store 节点对象引用 + zIndex + 选中态」缓存 wrapper：未变的节点复用旧引用，只有真正变化的节点重渲染。
  // selected 必须由 wrapper 携带（受控模式选中闭环：onNodesChange 应用 select 变化 → uiStore → 这里回填），
  // 否则 RF 内部选中态与渲染脱节（选中显示慢一拍）。
  const nodeWrapperCache = useRef(new Map<string, { src: CanvasNode; z: number; sel: boolean; wrapper: Node }>());
  const rfNodes = useMemo<Node[]>(() => {
    const cache = nodeWrapperCache.current;
    const selSet = new Set(selectedNodeIds);
    const seen = new Set<string>();
    const out: Node[] = [];
    for (const n of Object.values(nodesMap)) {
      seen.add(n.id);
      const isGroup = n.type === "group";
      const z = isGroup ? -100 : activeNodeId === n.id || stackDrawerNodeId === n.id ? 10000 : 1;
      const sel = selSet.has(n.id);
      const prev = cache.get(n.id);
      if (prev && prev.src === n && prev.z === z && prev.sel === sel) {
        out.push(prev.wrapper);
        continue;
      }
      const wrapper: Node = {
        id: n.id,
        type: n.type,
        position: { x: n.x, y: n.y },
        style: { width: n.w, height: n.h, zIndex: z },
        selected: sel,
        // data 对象按 id 稳定复用：避免 data 引用变化触发节点组件不必要的重渲染
        data: prev?.wrapper.data ?? { nodeId: n.id },
        parentId: undefined,
        extent: undefined,
      };
      cache.set(n.id, { src: n, z, sel, wrapper });
      out.push(wrapper);
    }
    // 清掉已删除节点的缓存（含切换分集画布后的整批失效）
    for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
    return out.sort((a, b) => {
      if (a.type === "group" && b.type !== "group") return -1;
      if (a.type !== "group" && b.type === "group") return 1;
      return 0;
    });
  }, [nodesMap, activeNodeId, selectedNodeIds, stackDrawerNodeId]);

  // 边 wrapper 同样按引用缓存：选中/激活变化时只有 active/picked 标志翻转的少数边换新对象，
  // 其余复用旧引用——否则点选/起拖瞬间全部边重渲染（起拖卡顿源之一）。
  // ⚠ 框选连线的选中态走 uiStore.selectedEdgeIds + className（.Qiji-edge--picked），**绝不给受控
  // edges 传 selected / 调 addSelectedEdges**——RF 内部选择状态与 prop 里的 selected 互相覆盖会
  // 造成 StoreUpdater setEdges 的 Maximum update depth 死循环（实测踩坑）。
  const selectedEdgeIds = useUiStore((s) => s.selectedEdgeIds);
  const edgeWrapperCache = useRef(new Map<string, { src: CanvasEdge; active: boolean; sel: boolean; wrapper: Edge }>());
  const rfEdges = useMemo<Edge[]>(
    () => {
      // 选中/激活节点的上下游连线 → active（高亮发光+流动）
      const activeSet = new Set<string>(selectedNodeIds);
      if (activeNodeId) activeSet.add(activeNodeId);
      const selEdgeSet = new Set(selectedEdgeIds);
      const cache = edgeWrapperCache.current;
      const seen = new Set<string>();
      const out: Edge[] = [];
      for (const e of Object.values(edgesMap)) {
        seen.add(e.id);
        const active = activeSet.has(e.source) || activeSet.has(e.target);
        const sel = selEdgeSet.has(e.id);
        const prev = cache.get(e.id);
        if (prev && prev.src === e && prev.active === active && prev.sel === sel) {
          out.push(prev.wrapper);
          continue;
        }
        const cls = [active ? "Qiji-edge--active" : "", sel ? "Qiji-edge--picked" : ""].filter(Boolean).join(" ");
        const wrapper: Edge = {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourcePort,
          targetHandle: e.targetPort,
          animated: e.kind === "continuation",
          data: { active },
          className: cls || undefined,
        };
        cache.set(e.id, { src: e, active, sel, wrapper });
        out.push(wrapper);
      }
      for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
      return out;
    },
    [edgesMap, selectedNodeIds, activeNodeId, selectedEdgeIds],
  );

  // 单击=选中 + 打开节点面板并居中视口（第94轮回归：双击太繁琐）。
  // 快捷键归属由焦点决定（useCanvasKeyboard.isEditingTarget）：面板不自动聚焦输入框，
  // 单击后快捷键仍作用于节点；用户点进提示词框后，快捷键让位给文字编辑。
  // 长按 Ctrl/⌘ 单击多选：此时只累加选区（由 ReactFlow 的 multiSelectionKeyCode 处理），
  // 不开面板、不居中视口——避免多选途中面板弹出/视口跳动打断操作。
  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (event.ctrlKey || event.metaKey) return; // Ctrl/⌘ 多选中：不开面板、不居中
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
      // 连线选区（框选可只圈中连线）：供「全部删除」与右击判定
      useUiStore.getState().setEdgeSelection(params.edges.map((e) => e.id));
      // 面板开着时选区移走（点了别的节点/多选）→ 先关旧面板（点别的节点时 onNodeClick 随后开新面板）
      const active = useUiStore.getState().activeNodeId;
      if (active && selectedIds.length > 0 && (selectedIds.length > 1 || !selectedIds.includes(active))) {
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
      // 框选了多条连线且右击其中一条 → 开菜单（全部删除）；单条连线右击直接删除（不弹菜单）
      const selEdges = useUiStore.getState().selectedEdgeIds;
      if (selEdges.length > 1 && selEdges.includes(edge.id)) {
        openContextMenu({ x: e.clientX, y: e.clientY, nodeId: null, edgeId: edge.id });
      } else {
        dispatchCommand({ type: "disconnect", edgeId: edge.id });
      }
    },
    [openContextMenu],
  );

  // ── 框选连线：框内**没有节点**时按几何拾取连线（React Flow 原生只在端点节点被选中时才选边）。
  // 选中走 RF 内部 addSelectedEdges → 触发 onSelectionChange 回写 uiStore.selectedEdgeIds，
  // 与既有「右击全部删除」「Delete 删除」「Esc/点空白清空」闭环一致。
  const selBoxStart = useRef<{ x: number; y: number } | null>(null);
  const onSelectionStart = useCallback(
    (e: ReactMouseEvent) => {
      // RF 在「首个越过阈值的 move」才回调（事件坐标=move 位置，不是按下点）；
      // 真实起点在 RF store 的 userSelectionRect.startX/Y（pointerdown 时记录，flow 坐标）。
      const rect = rfStoreApi.getState().userSelectionRect;
      selBoxStart.current = rect
        ? { x: rect.startX, y: rect.startY }
        : screenToFlowPosition({ x: e.clientX, y: e.clientY });
    },
    [rfStoreApi, screenToFlowPosition],
  );
  const onSelectionEnd = useCallback(
    (e: ReactMouseEvent) => {
      const start = selBoxStart.current;
      selBoxStart.current = null;
      if (!start) return;
      const end = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const rect = {
        x1: Math.min(start.x, end.x),
        y1: Math.min(start.y, end.y),
        x2: Math.max(start.x, end.x),
        y2: Math.max(start.y, end.y),
      };
      if (rect.x2 - rect.x1 < 6 && rect.y2 - rect.y1 < 6) return; // 单击级别的框不算框选
      const s = useCanvasStore.getState();
      // 框内有节点（Partial 相交，分组容器不算）→ RF 原生节点选择已处理，不接管
      const hasNode = Object.values(s.nodes).some(
        (n) =>
          n.type !== "group" &&
          n.x < rect.x2 && n.x + (n.w ?? 240) > rect.x1 &&
          n.y < rect.y2 && n.y + (n.h ?? 200) > rect.y1,
      );
      if (hasNode) return;
      const hitIds = pickEdgesInRect(rect, s.nodes, Object.values(s.edges));
      if (!hitIds.length) return;
      // 只写 uiStore（渲染走 className 高亮）——不调 addSelectedEdges，见 rfEdges 注释的死循环坑
      useUiStore.getState().setEdgeSelection(hitIds);
    },
    [screenToFlowPosition],
  );

  const onPaneClick = useCallback(() => {
    closeContextMenu();
    useUiStore.getState().setActiveNodeId(null);
    useUiStore.getState().setStackDrawerNodeId(null); // 点空白收起堆叠抽屉
    // 点空白无条件退出多选（不依赖 RF 的选区变更回调）：uiStore 选区与 RF 内部选区在部分
    // 路径会脱同步——脱了之后 RF 侧本就为空，点空白不触发 onSelectionChange，uiStore 的
    // 多选态（工具栏）就永远卡住。双向清空兜底。
    rfStoreApi.getState().unselectNodesAndEdges();
    useUiStore.getState().setSelection([]);
    useUiStore.getState().setEdgeSelection([]);
  }, [closeContextMenu, rfStoreApi]);

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
        connectionLineComponent={MultiConnectionLine}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onSelectionChange={onSelectionChange}
        onSelectionStart={onSelectionStart}
        onSelectionEnd={onSelectionEnd}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        onPaneClick={onPaneClick}
        onMouseDown={onMouseDown}
        onNodeClick={onNodeClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onDragOver={onDragOver}
        onDrop={onDrop}
        isValidConnection={isValidConnection}
        // 起拖不选中（默认 true 会在**起拖瞬间**触发 选中→操作面板挂载+边高亮重建，正是起拖卡顿；
        // 点击仍会选中/开面板，拖动已选中的多个节点也不受影响）
        selectNodesOnDrag={false}
        connectionRadius={60}
        proOptions={proOptions}
        defaultEdgeOptions={defaultEdgeOptions}
        minZoom={0.05}
        maxZoom={50}
        // 单击已开面板，双击不承载功能；禁用 React Flow 默认双击缩放（避免连点两下时视口跳缩放）
        zoomOnDoubleClick={false}
        onMoveStart={onMoveStart}
        onMoveEnd={onMoveEnd}
        onMove={onMove}
        // 平移按钮集：中键(1)/右键(2)拖动恒可平移；Space 长按时左键(0)也加入
        panOnDrag={isSpacePressed ? [0, 1, 2] : [1, 2]}
        selectionOnDrag={!isSpacePressed}
        selectionMode={SelectionMode.Partial}
        selectionKeyCode={null}
        // 长按 Ctrl/⌘ 单击多选节点（累加/再点取消）；显式声明避免依赖平台探测（Tauri WebView 更稳）
        multiSelectionKeyCode={["Control", "Meta"]}
        zoomOnScroll={true}
        panOnScroll={false}
        zoomActivationKeyCode={null}
      >
        {/* 点阵：≥2px 防平移时跨像素边界亚像素闪烁（shimmer）；亮度按用户反馈调明显（第100轮）；「网格」开关控制显隐 */}
        {showGrid && (
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={2.4}
            color="rgba(158,178,218,0.55)"
          />
        )}

        {/* 吸附对齐参考线（仅吸附命中时挂载，独立订阅不牵动 Canvas 本体） */}
        <SnapGuideLines />

        <Controls position="bottom-right" showInteractive={false} />

        <Panel position="top-left">
          <button
            onClick={tidyMindmap}
            title="整理画布（思维导图：主干居中、分支散开）"
            className="Qiji-panel pointer-events-auto flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] text-foreground shadow-lg hover:text-[color:var(--node-storyboard,#8fb4ff)] transition-colors cursor-pointer"
          >
            <Network className="h-4 w-4" />
            <span>整理</span>
          </button>
        </Panel>
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

      {connectMenu && (() => {
        // 拖到空白处 → 按拖出端口的方向/格式，列出可生成的上/下游节点。
        const start = connectStartRef.current;
        const startNode = start ? nodesMap[start.nodeId] : null;
        const startPlugin = startNode ? getPlugin(startNode.type) : null;
        const isFromOutput = start?.handleType === "source"; // 从输出口拖 → 生成下游节点
        const ports = isFromOutput ? startPlugin?.outputs : startPlugin?.inputs;
        const port = ports?.find((p) => p.name === start?.handleId) ?? ports?.[0];
        const fmts = new Set(port?.formats ?? []);
        const candidates = listPlugins().filter((p) => {
          if (p.inPalette === false || p.nodeKind === "upload") return false;
          const tp = isFromOutput ? p.inputs : p.outputs;
          return tp.length > 0 && tp.some((x) => x.formats.some((f) => fmts.has(f)));
        });
        return (
          <div
            style={{ position: "fixed", left: connectMenu.x, top: connectMenu.y, transform: "translate(-50%, 0)" }}
            className="Qiji-panel pointer-events-auto z-[10300] flex flex-col gap-0.5 rounded-xl p-1 shadow-2xl w-36 text-[11px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2 py-1 text-muted-foreground font-semibold text-[9px] uppercase border-b border-border/40 mb-1 select-none">
              {isFromOutput ? "生成下游节点" : "生成上游节点"}
            </div>
            {candidates.map((plugin) => {
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
            {candidates.length === 0 && (
              <div className="px-2 py-2 text-muted-foreground text-center italic">无兼容节点</div>
            )}
          </div>
        );
      })()}

      <AnimatePresence>
        {activeNodeId &&
          (() => {
            const node = useCanvasStore.getState().nodes[activeNodeId];
            if (!node) return null;
            const plugin = getPlugin(node.type);
            // 分镜组：无输入面板（全部操作在悬停工具条与格子右键菜单）
            if (node.type === "shot.group") return null;
            if (node.type === "ai.chat") {
              return <ChatPanel nodeId={activeNodeId} key={activeNodeId} />;
            }
            if (node.type === "video.gen") {
              return <VideoOperationPanel nodeId={activeNodeId} key={activeNodeId} />;
            }
            if (plugin?.nodeKind === "seed" || plugin?.nodeKind === "upload") {
              return <SimplePanel nodeId={activeNodeId} key={activeNodeId} />;
            }
            return <OperationPanel nodeId={activeNodeId} key={activeNodeId} />;
          })()}
      </AnimatePresence>

      <SelectionToolbar />

      {/* 节点数量预警（350/450/500/550+每10）：仅提示不拦截，自订阅小组件（§9） */}
      <NodeCountWarnToast />

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

      {/* 节点媒体处理弹窗（超分/去字幕/图像超分/分段）——工具栏与右键菜单共同入口 */}
      <NodeProcessModals />
    </div>
  );
}

/**
 * 多选/分组悬浮工具栏——独立组件的原因（性能关键）：
 * 它是画布里唯一需要"跟随视口逐帧定位"的 UI；由它自己订阅 viewport（onMove 每帧写入），
 * 平移/缩放时只有这个小组件重渲染，Canvas 本体（含 ReactFlow 全部节点）完全不动。
 */
function SelectionToolbar() {
  const selectedNodeIds = useUiStore((s) => s.selectedNodeIds);
  const nodesMap = useCanvasStore((s) => s.nodes);
  const storeViewport = useCanvasStore((s) => s.viewport);
  const { getViewport } = useReactFlow();

  const selectedNodes = useMemo(() => {
    return Object.values(nodesMap).filter((n) => selectedNodeIds.includes(n.id));
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

  // 多选：全部启动（逐个运行选中节点）
  const onRunSelected = useCallback(() => {
    selectedNodeIds.forEach((id) => dispatchCommand({ type: "run", nodeId: id }));
  }, [selectedNodeIds]);

  // 多选：匹配素材（为选中的「生成图片/生成视频」节点按上游文本匹配资产图，和资产模式一致；
  // 此前只匹配图片节点——视频节点被跳过，即「多选匹配失效」的根因）
  const onMatchSelected = useCallback(async () => {
    const { applyAssetMatchToImageNode } = await import("@/lib/assetMatch");
    const nodes = useCanvasStore.getState().nodes;
    selectedNodeIds.forEach((id) => {
      const node = nodes[id];
      const p = node ? getPlugin(node.type) : null;
      if (p?.displayKind === "image" || p?.displayKind === "video") applyAssetMatchToImageNode(id);
    });
  }, [selectedNodeIds]);

  // 多选：合并为分镜组（≥2 个有图片结果的节点才显示）
  const mergeableCount = useMemo(
    () =>
      selectedNodes.filter((n) => getPlugin(n.type)?.displayKind === "image" && !!n.data.resultAssetId).length,
    [selectedNodes],
  );
  const onMergeShotGroup = useCallback(async () => {
    const { createShotGroupFromNodes } = await import("@/canvas/shotGroupOps");
    const err = createShotGroupFromNodes(selectedNodeIds);
    if (err) alert(err);
  }, [selectedNodeIds]);

  // 多选：一键增加预设（对选中图片节点批量插入预设胶囊）+ 一键检查素材（探活自愈）
  const [presetOpen, setPresetOpen] = useState(false);
  const selImageCount = useMemo(() => imageNodeCount(selectedNodeIds), [selectedNodeIds]);
  const onAddPreset = useCallback((presetId: string) => {
    addPresetToNodes(selectedNodeIds, presetId);
    setPresetOpen(false);
  }, [selectedNodeIds]);
  const onCheckSelected = useCallback(() => {
    checkNodesAssets(selectedNodeIds);
  }, [selectedNodeIds]);

  if (!selectionToolbarStyle) return null;
  const presetSchemes = selImageCount > 0 ? listPresetSchemes() : [];

  return (
    <div
      style={selectionToolbarStyle}
      className="Qiji-panel pointer-events-auto z-[10250] flex items-center gap-1 rounded-xl p-1 shadow-2xl border border-white/10 text-xs text-foreground select-none"
    >
      {selectedNodes.length >= 2 && (
        <>
          <button
            onClick={onRunSelected}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-secondary cursor-pointer transition-colors font-medium text-[11px]"
          >
            <Play className="h-3.5 w-3.5 text-emerald-400" fill="currentColor" />
            <span>全部启动</span>
          </button>
          <button
            onClick={onMatchSelected}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-secondary cursor-pointer transition-colors font-medium text-[11px]"
          >
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            <span>匹配素材</span>
          </button>
          {selImageCount > 0 && (
            <div className="relative">
              <button
                onClick={() => setPresetOpen((v) => !v)}
                title={`把预设胶囊插入选中的 ${selImageCount} 个图片节点提示词`}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-secondary cursor-pointer transition-colors font-medium text-[11px]"
              >
                <Palette className="h-3.5 w-3.5 text-fuchsia-300" />
                <span>增加预设</span>
              </button>
              {presetOpen && (
                <div className="Qiji-panel absolute left-0 top-full mt-1 max-h-72 w-40 overflow-y-auto rounded-xl p-1 shadow-2xl z-[10260]">
                  {presetSchemes.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => onAddPreset(p.id)}
                      className="flex w-full items-center rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors text-left text-[11px]"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            onClick={onCheckSelected}
            title="检查选中节点的结果+素材云端（OSS）直链是否正常，死链且本机有本地副本则自动修复"
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-secondary cursor-pointer transition-colors font-medium text-[11px]"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
            <span>检查素材</span>
          </button>
          <div className="h-4 w-[1px] bg-border/40" />
          <button
            onClick={onGroupSelected}
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-secondary cursor-pointer transition-colors font-medium text-[11px]"
          >
            <Combine className="h-3.5 w-3.5 text-primary" />
            <span>合并打组</span>
          </button>
          {mergeableCount >= 2 && (
            <button
              onClick={() => void onMergeShotGroup()}
              title={`把 ${mergeableCount} 个图片节点的主图合并为一个分镜组节点（宫格布局，源节点删除，可撤销）`}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 hover:bg-secondary cursor-pointer transition-colors font-medium text-[11px]"
            >
              <LayoutGrid className="h-3.5 w-3.5 text-sky-400" />
              <span>分镜组</span>
            </button>
          )}
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
  );
}
