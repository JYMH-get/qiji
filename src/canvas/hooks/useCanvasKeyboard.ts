import { useEffect, useState } from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { useSettingsStore } from "@/store/settingsStore";
import { getPlugin } from "@/nodes/pluginRegistry";
import { useLightboxStore } from "@/store/lightboxStore";
import { usePromptModalStore } from "@/store/promptModalStore";
import { dispatchCommand } from "@/command/dispatch";
import { copyToClipboard, splitEdgesForCopy } from "@/lib/clipboard";
import { pasteInternalNodes } from "@/canvas/pasteInternal";
import { copyNodesImageToSystemClipboard } from "@/canvas/copyImage";
import { comboFromEvent, resolveActionId } from "@/canvas/keymap";

/** 在输入框/文本域/contentEditable 内时，画布快捷键让位给浏览器原生编辑（useCanvasPaste 共用） */
export function isEditingTarget(): boolean {
  const el = document.activeElement;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.getAttribute("contenteditable") === "true");
}

/** 顶层弹窗（设置/个人中心/黑盒/图像编辑/信息/处理弹窗/灯箱/放大编辑）开着时，画布快捷键让位（useCanvasPaste 共用） */
export function topLayerOpen(): boolean {
  const ui = useUiStore.getState();
  return (
    !!(ui.settingsOpen || ui.personalCenterOpen || ui.imageEditNodeId || ui.nodeInfoNodeId || ui.nodeProcModal) ||
    !!useLightboxStore.getState().item ||
    usePromptModalStore.getState().open
  );
}

/**
 * 键盘快捷键（画布模式）。
 *
 * **可自定义键**（默认键与动作清单见 src/canvas/keymap.ts 注册表；设置面板「快捷键」tab 改绑，
 * 存 settingsStore.canvasKeymap）：撤销/重做、精准复制/全能复制/粘贴、删除节点、全选、
 * 打组/解除打组、运行节点、放大/缩小/适配全图、打开收起堆叠(C)。
 *
 * **固定键**（不进注册表）：Esc（关菜单→关抽屉→清选区/关面板）、方向键平移画布（Shift=大步；
 * 焦点在节点上时让位给 RF 微移节点）、Space 长按平移、Ctrl+Shift+Z 重做别名、Alt+拖动复制。
 */
export function useCanvasKeyboard() {
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const { screenToFlowPosition, getViewport, setViewport, zoomIn, zoomOut, fitView } = useReactFlow();
  const rfStore = useStoreApi();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const combo = comboFromEvent(e);
      if (!combo) return; // 纯修饰键
      const actionId = resolveActionId(combo, useSettingsStore.getState().canvasKeymap);

      // 删除节点：聚焦展开节点面板（含面板内提示词编辑器聚焦）下也能删——该特权仅在绑定
      // 仍是 Delete 键时生效（改绑字符键后编辑中一律让位，防打字误删）。Backspace 恒不删节点。
      if (actionId === "deleteNode") {
        const ui = useUiStore.getState();
        // 顶层弹窗（设置/个人中心/图像编辑）打开时让位给其内部编辑
        if (ui.settingsOpen || ui.personalCenterOpen || ui.imageEditNodeId) return;
        const el = document.activeElement as HTMLElement | null;
        if (isEditingTarget() && !(combo === "delete" && el?.closest("[data-node-panel]"))) return;
        // 选中优先；无选中则删当前聚焦的单节点（activeNodeId）。框选中的连线同样受 Delete 控制（如同节点）
        const ids = ui.selectedNodeIds.length > 0
          ? ui.selectedNodeIds
          : ui.activeNodeId
            ? [ui.activeNodeId]
            : [];
        const edgeIds = ui.selectedEdgeIds;
        if (ids.length === 0 && edgeIds.length === 0) return;
        e.preventDefault();
        ids.forEach((id) => dispatchCommand({ type: "deleteNode", id }));
        // 删节点会级联删边——只断开仍存在的选中连线
        const edgesNow = useCanvasStore.getState().edges;
        edgeIds.forEach((id) => {
          if (edgesNow[id]) dispatchCommand({ type: "disconnect", edgeId: id });
        });
        ui.setSelection([]);
        ui.setEdgeSelection([]);
        ui.setActiveNodeId(null);
        return;
      }

      if (isEditingTarget()) return; // 编辑文本时不触发其余画布快捷键
      if (topLayerOpen()) return; // 顶层弹窗开着时让位（弹窗自己的 Esc/Ctrl+Enter 语义优先）

      // ── 固定键：Esc——先关右键菜单；再关堆叠抽屉；再清选区/退出多选/关节点面板 ──
      if (e.key === "Escape" && !e.ctrlKey && !e.metaKey) {
        const ui = useUiStore.getState();
        if (ui.contextMenu) {
          ui.closeContextMenu();
          return;
        }
        if (ui.stackDrawerNodeId) {
          ui.setStackDrawerNodeId(null);
          return;
        }
        rfStore.getState().unselectNodesAndEdges();
        ui.setSelection([]);
        ui.setEdgeSelection([]);
        ui.setActiveNodeId(null);
        return;
      }

      // ── 固定键：方向键平移画布（Shift=大步）；Ctrl/Alt 组合留给系统与其它功能。
      // 焦点在节点上（单击选中后）时让位给 React Flow 内置的「方向键微移节点」，避免双触发。
      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.startsWith("Arrow")) {
        const el = document.activeElement as HTMLElement | null;
        if (el?.closest(".react-flow__node")) return;
        e.preventDefault();
        const step = e.shiftKey ? 360 : 120;
        const vp = getViewport();
        const dx = e.key === "ArrowLeft" ? step : e.key === "ArrowRight" ? -step : 0;
        const dy = e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0;
        setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom });
        return;
      }

      if (!actionId) return;

      // ── 注册表动作（键位可在 设置→快捷键 自定义） ──
      switch (actionId) {
        case "undo": {
          e.preventDefault();
          dispatchCommand({ type: "undo" });
          return;
        }
        case "redo": {
          e.preventDefault();
          dispatchCommand({ type: "redo" });
          return;
        }
        case "selectAll": {
          // 全选：写 RF 内部选区（onSelectionChange 回写 uiStore，工具栏/快捷键即可用）
          const ids = Object.keys(useCanvasStore.getState().nodes);
          if (ids.length > 0) {
            e.preventDefault();
            rfStore.getState().addSelectedNodes(ids);
          }
          return;
        }
        case "group": {
          const selectedIds = useUiStore.getState().selectedNodeIds;
          if (selectedIds.length > 1) {
            e.preventDefault();
            dispatchCommand({ type: "group", nodeIds: selectedIds });
          }
          return;
        }
        case "ungroup": {
          // 解除打组：选中的分组容器 + 组内节点所属的组，全部解散（与多选工具栏同语义）
          const st = useCanvasStore.getState();
          const gids = new Set<string>();
          for (const id of useUiStore.getState().selectedNodeIds) {
            const n = st.nodes[id];
            if (!n) continue;
            if (n.type === "group") gids.add(n.id);
            else if (n.parentId) gids.add(n.parentId);
          }
          if (gids.size > 0) {
            e.preventDefault();
            gids.forEach((gid) => dispatchCommand({ type: "ungroup", groupId: gid }));
            useUiStore.getState().setSelection([]);
          }
          return;
        }
        case "copy": {
          // 精准复制：只带选中节点 + 选中集内部连线
          const selectedIds = useUiStore.getState().selectedNodeIds;
          if (selectedIds.length > 0) {
            e.preventDefault();
            const state = useCanvasStore.getState();
            const selectedSet = new Set(selectedIds);
            const selectedNodes = selectedIds.map((id) => state.nodes[id]).filter(Boolean);
            const selectedEdges = Object.values(state.edges).filter(
              (edge) => selectedSet.has(edge.source) && selectedSet.has(edge.target),
            );
            copyToClipboard(selectedNodes, selectedEdges);
            copyNodesImageToSystemClipboard(selectedNodes); // 顺带：首个图片结果进系统剪贴板（可粘贴到简一助手）
          }
          return;
        }
        case "superCopy": {
          // 全能复制：节点 + 内部连线 + 上游连线（粘贴时自动把原上游接回克隆体）
          const selectedIds = useUiStore.getState().selectedNodeIds;
          if (selectedIds.length > 0) {
            e.preventDefault();
            const state = useCanvasStore.getState();
            const selectedSet = new Set(selectedIds);
            const nodes = selectedIds.map((id) => state.nodes[id]).filter((n) => n && n.type !== "group");
            const { internal, upstream } = splitEdgesForCopy(selectedSet, state.edges);
            copyToClipboard(nodes, internal, upstream);
            copyNodesImageToSystemClipboard(nodes); // 顺带：首个图片结果进系统剪贴板（可粘贴到简一助手）
          }
          return;
        }
        case "paste": {
          // 真实 Ctrl+V：这里不处理也不 preventDefault——放行原生 paste 事件，由 useCanvasPaste
          // 统一分流（内部节点克隆 / 系统剪贴板图片→图片节点 / 文字→文本节点）。
          // 改绑成其它组合键时原生 paste 不会触发，仍在此走内部节点粘贴（系统剪贴板内容不可得）。
          if (combo === "ctrl+v") return;
          const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
          if (pasteInternalNodes(center, () => rfStore.getState().unselectNodesAndEdges())) {
            e.preventDefault();
          }
          return;
        }
        case "runSelected": {
          // 运行选中节点（多选=全部启动）；无选中则运行面板聚焦节点
          const ui = useUiStore.getState();
          const ids = ui.selectedNodeIds.length > 0 ? ui.selectedNodeIds : ui.activeNodeId ? [ui.activeNodeId] : [];
          const st = useCanvasStore.getState();
          const runnable = ids.filter((id) => st.nodes[id] && st.nodes[id].type !== "group");
          if (runnable.length > 0) {
            e.preventDefault();
            runnable.forEach((id) => dispatchCommand({ type: "run", nodeId: id }));
          }
          return;
        }
        case "zoomIn": {
          e.preventDefault();
          zoomIn({ duration: 150 });
          return;
        }
        case "zoomOut": {
          e.preventDefault();
          zoomOut({ duration: 150 });
          return;
        }
        case "fitView": {
          e.preventDefault();
          fitView({ padding: 0.2, duration: 300 });
          return;
        }
        case "toggleStack": {
          // 打开/收起堆叠抽屉：作用于选中的单个图片/视频节点（有结果即可开——
          // 老节点可能只有主图没 history）；无合适选中但有抽屉开着 → 收起。
          const ui = useUiStore.getState();
          const st = useCanvasStore.getState();
          const cand =
            ui.selectedNodeIds.length === 1 ? ui.selectedNodeIds[0] : ui.activeNodeId;
          const n = cand ? st.nodes[cand] : null;
          const dk = n ? getPlugin(n.type)?.displayKind : undefined;
          const stackable =
            (dk === "image" || dk === "video") &&
            (!!n?.data.resultAssetId || (n?.data.resultHistory?.length ?? 0) > 0);
          if (cand && stackable) {
            e.preventDefault();
            ui.setStackDrawerNodeId(ui.stackDrawerNodeId === cand ? null : cand);
          } else if (ui.stackDrawerNodeId) {
            e.preventDefault();
            ui.setStackDrawerNodeId(null);
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [screenToFlowPosition, getViewport, setViewport, zoomIn, zoomOut, fitView, rfStore]);

  // 空格长按拖动画布
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

  return { isSpacePressed };
}
