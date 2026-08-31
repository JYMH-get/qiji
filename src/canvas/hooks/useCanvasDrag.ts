import { useCallback, useRef } from "react";
import type { Node, NodeChange } from "@xyflow/react";
import { useReactFlow } from "@xyflow/react";
import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { dispatchCommand } from "@/command/dispatch";
import { resolveCollision } from "@/canvas/nodeFactory";
import { cloneNodesWithEdges, prepareAltDragDuplicate, splitEdgesForCopy } from "@/lib/clipboard";
import { getPlugin } from "@/nodes/pluginRegistry";
import { computeBranchPush, type PushRect } from "@/lib/branchPush";
import { snapPosition, type SnapGuide } from "@/lib/dragSnap";

/** 拖入堆叠：悬停在同类节点上需持续满这个毫秒数，松开才并入（参考手机桌面图标入抽屉；
 *  1.5s——比拖出堆叠(1s)略长，与「拖动挤开」并存时误入堆叠的窗口更小，用户实测定档） */
const STACK_MERGE_ARM_MS = 1500;

interface CanvasNodeLike {
  id: string;
  type: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  parentId: string | null;
}

/** 拖拽期间暂停历史记录写入（标记本体在 interaction.ts——零依赖模块，command 层也要读） */
import { setNodeDragging, isNodeDragging } from "@/canvas/interaction";
export const isDragHistoryPaused = isNodeDragging;

/** 组节点关联 ID 收集 */
export const getGroupRelatedNodeIds = (
  nodeId: string,
  nodesMap: Record<string, CanvasNodeLike>,
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

/** 重算组节点边界 */
function syncGroupBounds(nodeIds: string[]) {
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
        const groupX = minX - 20;
        const groupY = minY - 40;
        const groupW = maxX - minX + 40;
        const groupH = maxY - minY + 60;

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
}

/** 节点拖拽：rAF 节流 + 组边界同步 + historyPaused */
export function useCanvasDrag() {
  const dragStartPositions = useRef<Record<string, { x: number; y: number }>>(
    {},
  );
  const rafId = useRef<number>(0);
  const pendingUpdates = useRef<Record<string, { x: number; y: number }>>({});
  const { setCenter, getViewport } = useReactFlow();

  // ── 抽屉式堆叠·拖入检测：单个图片/视频结果节点拖到**同类**结果节点上，
  //    悬停满 1.5 秒武装（节点高亮提示），松开即整节点并入目标堆叠（mergeNodeIntoStack）。
  const stackMergeRef = useRef<{
    sourceId: string;
    targetId: string;
    armed: boolean;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);

  const clearStackMerge = useCallback(() => {
    const m = stackMergeRef.current;
    if (m?.timer) clearTimeout(m.timer);
    stackMergeRef.current = null;
    if (useUiStore.getState().stackMerge) useUiStore.getState().setStackMerge(null);
  }, []);

  // ── 枝干让位（挤开）实时预览：单节点拖到节点 B 上 → B 连同同枝干（下游子树+独占上游链）
  //    被挤开让位（级联）；拖走即回原位；松手才通过 updateNodePosition 提交（replaces 旧「拖动者被避让」）。
  //    orig=被挤节点的拖前坐标（也是让位计算的基准，保证同一拖动位置结果稳定）；applied=当前预览坐标。
  const pushRef = useRef<{
    orig: Map<string, { x: number; y: number }>;
    applied: Map<string, { x: number; y: number }>;
  } | null>(null);

  /** rAF 节流：合并同一帧内的多次 moveNode 调用 */
  const flushDragUpdates = useCallback(() => {
    rafId.current = 0;
    const batch = pendingUpdates.current;
    pendingUpdates.current = {};
    const ids = Object.keys(batch);
    if (ids.length === 0) return;

    // 单次合并 setState（性能关键，勿改回逐节点 moveNode）：多选拖动 N 个节点时，
    // 逐个 moveNode = 每帧 N 次 store 通知 → Canvas/rfNodes/小地图/多选工具栏每帧各重算 N 遍，
    // 正是「多选拖动卡顿」的主因。合并成一次 setState 后每帧只通知一遍。
    const nodes = { ...useCanvasStore.getState().nodes };
    let changed = false;
    for (const id of ids) {
      const n = nodes[id];
      if (n) {
        nodes[id] = { ...n, x: batch[id].x, y: batch[id].y };
        changed = true;
      }
    }
    if (changed) useCanvasStore.setState({ nodes });
    syncGroupBounds(ids);
  }, []);

  /** 将一次 moveNode 调用排入 rAF 批次 */
  const scheduleDragUpdate = useCallback(
    (id: string, x: number, y: number) => {
      pendingUpdates.current[id] = { x, y };
      if (!rafId.current) {
        rafId.current = requestAnimationFrame(flushDragUpdates);
      }
    },
    [flushDragUpdates],
  );

  /** 吸附参考线写入（去抖：签名没变不 setState——拖动逐帧调用，只有命中/离开/换线时才通知） */
  const guideSigRef = useRef("");
  const setGuides = useCallback((g: SnapGuide[] | null) => {
    const sig = g?.length
      ? g.map((x) => `${x.axis}:${Math.round(x.value)}:${Math.round(x.from)}:${Math.round(x.to)}`).join("|")
      : "";
    if (sig === guideSigRef.current) return;
    guideSigRef.current = sig;
    useUiStore.getState().setSnapGuides(g?.length ? g : null);
  }, []);

  /** 清掉让位预览：被挤节点全部回原位（含尚未 flush 的 rAF 排队项） */
  const clearPushPreview = useCallback(() => {
    const p = pushRef.current;
    pushRef.current = null;
    if (!p || p.orig.size === 0) return;
    for (const id of p.orig.keys()) delete pendingUpdates.current[id];
    const nodes = { ...useCanvasStore.getState().nodes };
    let changed = false;
    for (const [id, pos] of p.orig) {
      const n = nodes[id];
      if (n && (n.x !== pos.x || n.y !== pos.y)) {
        nodes[id] = { ...n, x: pos.x, y: pos.y };
        changed = true;
      }
    }
    if (changed) useCanvasStore.setState({ nodes });
  }, []);

  const onNodeDrag = useCallback(
    (_event: unknown, node: Node, nodes: Node[]) => {
      const s = useCanvasStore.getState();
      const src = s.nodes[node.id];
      const single = nodes.length === 1;

      // ── ① 拖入堆叠检测（原语义：单节点拖动、媒体结果节点、拖动中心落入同类结果节点矩形） ──
      const srcKind = src ? getPlugin(src.type)?.displayKind : undefined;
      const mergeCapable =
        single && !!src && src.type !== "group" && (srcKind === "image" || srcKind === "video") && !!src.data.resultAssetId;
      if (!mergeCapable) {
        if (stackMergeRef.current) clearStackMerge();
      } else {
        // 命中判定用 RF 回调的实时坐标（store 位置经 rAF 滞后一帧）：拖动节点中心落入目标矩形
        const cx = node.position.x + (src!.w ?? 240) / 2;
        const cy = node.position.y + (src!.h ?? 200) / 2;
        let targetId: string | null = null;
        for (const n of Object.values(s.nodes)) {
          if (n.id === node.id || n.type === "group") continue;
          if (getPlugin(n.type)?.displayKind !== srcKind || !n.data.resultAssetId) continue;
          if (cx >= n.x && cx <= n.x + (n.w ?? 240) && cy >= n.y && cy <= n.y + (n.h ?? 200)) {
            targetId = n.id;
            break;
          }
        }
        const cur = stackMergeRef.current;
        if (!targetId) {
          if (cur) clearStackMerge();
        } else if (!(cur && cur.targetId === targetId && cur.sourceId === node.id)) {
          clearStackMerge();
          const entry = {
            sourceId: node.id,
            targetId,
            armed: false,
            timer: null as ReturnType<typeof setTimeout> | null,
          };
          entry.timer = setTimeout(() => {
            if (stackMergeRef.current === entry) {
              entry.armed = true;
              useUiStore.getState().setStackMerge({ targetId: entry.targetId, armed: true });
            }
          }, STACK_MERGE_ARM_MS);
          stackMergeRef.current = entry;
          useUiStore.getState().setStackMerge({ targetId, armed: false });
        }
      }

      // ── ② 枝干让位实时预览（单选或多选整组拖动；分组容器/组内节点参与时不挤；「重叠」开关开着时不挤） ──
      const dragged = nodes
        .map((nd) => ({ nd, sn: s.nodes[nd.id] }))
        .filter((x): x is { nd: Node; sn: NonNullable<typeof x.sn> } => !!x.sn);
      const pushable =
        dragged.length > 0 &&
        dragged.every((x) => x.sn.type !== "group" && !x.sn.parentId) &&
        !useUiStore.getState().allowOverlap;
      if (!pushable) {
        clearPushPreview();
        return;
      }
      const dragIds = new Set(dragged.map((x) => x.nd.id));
      const prevOrig = pushRef.current?.orig;
      const baseById = new Map<string, PushRect>();
      const baseNodes: PushRect[] = [];
      for (const n of Object.values(s.nodes)) {
        if (dragIds.has(n.id)) continue;
        const o = prevOrig?.get(n.id);
        const r: PushRect = { id: n.id, type: n.type, x: o ? o.x : n.x, y: o ? o.y : n.y, w: n.w, h: n.h, parentId: n.parentId };
        baseById.set(n.id, r);
        baseNodes.push(r);
      }
      // 堆叠并入候选（同类媒体结果节点）不挤开——挤走了就永远悬停不满 1.5 秒、并入功能失效
      const isMergeCompat = (r: PushRect) => {
        if (!mergeCapable) return false;
        const t = s.nodes[r.id];
        return !!t && getPlugin(t.type)?.displayKind === srcKind && !!t.data.resultAssetId;
      };
      const res = computeBranchPush(
        dragged.map((x) => ({ id: x.nd.id, x: x.nd.position.x, y: x.nd.position.y, w: x.sn.w, h: x.sn.h })),
        baseNodes,
        Object.values(s.edges),
        { skipTarget: isMergeCompat },
      );
      const nextMoved = res?.moved ?? null;

      // 差分落地（走 rAF 批次，与拖动本体更新合并成单次 setState）：
      // 新被挤 → 预览坐标；不再被挤 → 回原位（"节点 B 回归原位"）
      const orig = new Map(prevOrig ?? []);
      const applied = new Map<string, { x: number; y: number }>();
      if (prevOrig) {
        for (const [id, pos] of prevOrig) {
          if (!nextMoved?.has(id)) {
            scheduleDragUpdate(id, pos.x, pos.y);
            orig.delete(id);
          }
        }
      }
      if (nextMoved) {
        for (const [id, pos] of nextMoved) {
          if (!orig.has(id)) {
            const b = baseById.get(id);
            if (b) orig.set(id, { x: b.x, y: b.y });
          }
          applied.set(id, pos);
          scheduleDragUpdate(id, pos.x, pos.y);
        }
      }
      pushRef.current = orig.size > 0 ? { orig, applied } : null;
    },
    [clearStackMerge, clearPushPreview, scheduleDragUpdate],
  );

  const onNodeDragStart = useCallback(
    (_event: unknown, _node: Node, nodes: Node[]) => {
      setNodeDragging(true);
      clearStackMerge(); // 清上一次拖动的残留悬停/武装态
      clearPushPreview(); // 清上一次拖动残留的让位预览（被挤节点回原位）

      // ALT+拖动 = 拖动复制：起拖瞬间在原位落一份克隆（含内部连线 + 上游连线），
      // 原节点被继续拖走。语义：**留在原地的克隆 = 完整替身**（承接原节点的下游连线），
      // **被拖走的 = 只带上游连线的复制体**——下游流水线不跟着被拖走的节点跑。
      const me = _event as { altKey?: boolean } | null;
      if (me?.altKey) {
        const s = useCanvasStore.getState();
        const sel = useUiStore.getState().selectedNodeIds;
        const baseIds = sel.length > 1 && sel.includes(_node.id) ? sel : [_node.id];
        const set = new Set(baseIds);
        const srcNodes = baseIds.map((id) => s.nodes[id]).filter((n) => n && n.type !== "group");
        if (srcNodes.length) {
          const { internal, upstream } = splitEdgesForCopy(set, s.edges);
          const built = cloneNodesWithEdges(srcNodes, internal, upstream);
          dispatchCommand({ type: "pasteNodes", nodes: built.nodes, edges: built.edges });
          // 下游连线移交克隆：把「source=被拖节点、target 在选中集外」的边改写到原位克隆上。
          // 紧跟 pasteNodes 同步执行——历史快照已在命令前压栈，撤销一次即整体回退（含改写）。
          const st = useCanvasStore.getState();
          const edges = { ...st.edges };
          let changed = false;
          for (const [eid, e] of Object.entries(edges)) {
            const cloneId = built.idMap.get(e.source);
            if (cloneId && !set.has(e.target) && !built.idMap.has(e.target)) {
              edges[eid] = { ...e, source: cloneId };
              changed = true;
            }
          }
          if (changed) useCanvasStore.setState({ edges });

          // 被拖走的是用于继续抽卡的空白副本：保留输入/提示词/模型设置，清掉全部结果与在途态；
          // 原位克隆继续承接旧结果、结果历史与下游连线。upload 资产节点例外，它本身只有结果。
          const latest = useCanvasStore.getState();
          const nodesNow = { ...latest.nodes };
          const runtimeNow = { ...latest.runtime };
          let resetAny = false;
          for (const id of baseIds) {
            const n = nodesNow[id];
            if (!n || n.type === "group") continue;
            const prepared = prepareAltDragDuplicate(n);
            nodesNow[id] = prepared.node;
            runtimeNow[id] = prepared.runtime;
            resetAny = true;
          }
          if (resetAny) useCanvasStore.setState({ nodes: nodesNow, runtime: runtimeNow });
        }
      }

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
    [clearStackMerge],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const store = useCanvasStore.getState();
      let hasDragEnd = false;

      // 选中/取消选中：受控模式下 React Flow 只把 select 变化发到这里、自己不落地——必须应用到
      // uiStore，Canvas 的 rfNodes 再按 selectedNodeIds 回填 wrapper.selected 才算闭环。
      // 此前 select 变化被丢弃 → 节点选中态永远慢一拍（点 B 才显出 A 的选中）。
      let selChanged = false;
      const selSet = new Set(useUiStore.getState().selectedNodeIds);
      for (const ch of changes) {
        if (ch.type === "select") {
          selChanged = true;
          if (ch.selected) selSet.add(ch.id);
          else selSet.delete(ch.id);
        }
      }
      if (selChanged) useUiStore.getState().setSelection(Array.from(selSet));

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

      // 吸附对齐（AssetPanel「吸附」开关）：单节点拖动时对齐其它节点的边缘/中线，
      // 命中时显示参考线（跨度覆盖拖动节点↔对齐节点，标出对齐到谁）。
      // ⚠ 只在**有拖动位移的事件**里写/清参考线——RF 同一次移动会再发一拨无位置变更的
      // onNodesChange，此前无条件 setGuides(null) 让参考线一闪(<16ms)即灭=「看不到对齐线」根因；
      // 拖动结束的清空在 hasDragEnd 分支显式做。
      {
        const ids = Object.keys(dragUpdates);
        if (ids.length > 0) {
          let guides: SnapGuide[] | null = null;
          if (ids.length === 1 && useUiStore.getState().snapAlign) {
            const id = ids[0];
            const sn = store.nodes[id];
            if (sn && sn.type !== "group") {
              const r = snapPosition(
                { id, x: dragUpdates[id].x, y: dragUpdates[id].y, w: sn.w, h: sn.h },
                Object.values(store.nodes),
              );
              dragUpdates[id] = { x: r.x, y: r.y };
              if (r.guides.length) guides = r.guides;
            }
          }
          setGuides(guides);
        }
      }

      // 拖拽中走 rAF 批量更新，避免逐帧 setState 触发大量重渲染
      for (const [id, pos] of Object.entries(dragUpdates)) {
        scheduleDragUpdate(id, pos.x, pos.y);
      }

      if (hasDragEnd) {
        // 确保剩余 rAF 中的更新已 flush
        if (rafId.current) {
          cancelAnimationFrame(rafId.current);
          rafId.current = 0;
        }
        flushDragUpdates();

        setNodeDragging(false);
        setGuides(null); // 拖动结束：清掉吸附参考线（拖动中不再无条件清，见上方注释）

        // 拖入堆叠：捕获武装态（悬停同类节点已满 1 秒）后立即清掉高亮指示——成不成交都不再显示
        const stackMergeArmed = stackMergeRef.current?.armed
          ? { sourceId: stackMergeRef.current.sourceId, targetId: stackMergeRef.current.targetId }
          : null;
        clearStackMerge();

        // 枝干让位·提交快照：松手时若有让位预览，被挤节点按预览坐标提交（进同一次 updateNodePosition），
        // 拖动者原地落下、不再参与落子避让（替代旧「拖动者被挤开」语义）。
        const pushCommit =
          pushRef.current && pushRef.current.orig.size > 0
            ? { orig: new Map(pushRef.current.orig), applied: new Map(pushRef.current.applied) }
            : null;
        pushRef.current = null;

        const dragEnds: {
          id: string;
          x: number;
          y: number;
          startX: number;
          startY: number;
        }[] = [];
        for (const ch of changes) {
          if (
            ch.type === "position" &&
            ch.position &&
            ch.dragging === false
          ) {
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

          // 吸附对齐：单节点拖动的最终落点同样吸附（拖动中只吸附了 store 预览，RF 内部坐标未吸附）
          if (uniqueEnds.length === 1 && useUiStore.getState().snapAlign) {
            const sn = store.nodes[uniqueEnds[0].id];
            if (sn && sn.type !== "group") {
              const p = snapPosition(
                { id: sn.id, x: uniqueEnds[0].x, y: uniqueEnds[0].y, w: sn.w, h: sn.h },
                Object.values(store.nodes),
              );
              uniqueEnds[0].x = p.x;
              uniqueEnds[0].y = p.y;
            }
          }

          // 拖入堆叠·成交：源节点从常规落子流程剔除（不参与避让/位置命令），改派 mergeNodeIntoStack
          //（并入目标 resultHistory + 删除源节点，一次撤销）。
          let mergeCmd: { sourceId: string; targetId: string } | null = null;
          if (stackMergeArmed && store.nodes[stackMergeArmed.targetId] && store.nodes[stackMergeArmed.sourceId]) {
            const idx = uniqueEnds.findIndex((u) => u.id === stackMergeArmed.sourceId);
            if (idx >= 0) {
              uniqueEnds.splice(idx, 1);
              delete dragStartPositions.current[stackMergeArmed.sourceId];
              mergeCmd = stackMergeArmed;
            }
          }

          // 还原到拖拽前坐标，以确保 pushHistory 时存入拖拽前的状态（单次合并 setState）；
          // 被挤开的节点同样回原位——让位坐标随命令提交，历史快照里是拖前状态（一次撤销整体回退）
          {
            const nodesRestore = { ...useCanvasStore.getState().nodes };
            let restored = false;
            for (const item of uniqueEnds) {
              const n = nodesRestore[item.id];
              if (n) {
                nodesRestore[item.id] = { ...n, x: item.startX, y: item.startY };
                restored = true;
              }
            }
            if (pushCommit) {
              for (const [id, pos] of pushCommit.orig) {
                const n = nodesRestore[id];
                if (n) {
                  nodesRestore[id] = { ...n, x: pos.x, y: pos.y };
                  restored = true;
                }
              }
            }
            if (restored) useCanvasStore.setState({ nodes: nodesRestore });
          }
          syncGroupBounds(uniqueEnds.map((item) => item.id));

          // 落子不重合：被拖的顶层节点若与未拖动节点(或彼此)相交，沿上/下/左/右就近移到空位；
          // 记录被自动纠正者，拖拽结束后聚焦，让用户看到落点。分组容器/分组子节点不参与。
          // 「重叠」开关（allowOverlap）开着时跳过全部避让，允许自由堆叠；
          // 枝干让位成交时同样跳过——拖动者原地落下，让位的是被压住的枝干（第100轮语义反转）。
          const allowOverlap = useUiStore.getState().allowOverlap;
          const draggedIds = new Set(uniqueEnds.map((u) => u.id));
          const stationary = Object.values(store.nodes).filter(
            (n) => !draggedIds.has(n.id) && n.type !== "group",
          );
          const nudged: { x: number; y: number; w: number; h: number }[] = [];
          for (const item of allowOverlap || pushCommit ? [] : uniqueEnds) {
            const sn = store.nodes[item.id];
            if (!sn || sn.type === "group" || sn.parentId) continue;
            const others = [
              ...stationary,
              ...uniqueEnds
                .filter((o) => o.id !== item.id)
                .map((o) => {
                  const on = store.nodes[o.id];
                  return { id: o.id, type: on?.type || "", x: o.x, y: o.y, w: on?.w, h: on?.h };
                }),
            ];
            const free = resolveCollision(
              { id: item.id, type: sn.type, x: item.x, y: item.y, w: sn.w, h: sn.h },
              others,
            );
            if (free) {
              item.x = free.x;
              item.y = free.y;
              nudged.push({ x: free.x, y: free.y, w: sn.w || 240, h: sn.h || 200 });
            }
          }

          // 整组避让：被拖的分组(连同子节点整体移动)若其外框与非成员节点相交，沿上/下/左/右就近**整组**移到空位。
          for (const item of allowOverlap ? [] : uniqueEnds) {
            const gn = store.nodes[item.id];
            if (!gn || gn.type !== "group") continue;
            const memberSet = new Set<string>([item.id]);
            for (const u of uniqueEnds) if (store.nodes[u.id]?.parentId === item.id) memberSet.add(u.id);
            const obstacles = Object.values(store.nodes)
              .filter((n) => !memberSet.has(n.id) && n.type !== "group")
              .map((n) => {
                const fin = uniqueEndsMap[n.id];
                return fin ? { id: n.id, type: n.type, x: fin.x, y: fin.y, w: n.w, h: n.h } : n;
              });
            const free = resolveCollision(
              { id: item.id, type: "groupbox", x: item.x, y: item.y, w: gn.w, h: gn.h },
              obstacles,
            );
            if (free) {
              const dx = free.x - item.x;
              const dy = free.y - item.y;
              item.x = free.x;
              item.y = free.y;
              for (const u of uniqueEnds) {
                if (u.id !== item.id && memberSet.has(u.id)) { u.x += dx; u.y += dy; }
              }
              nudged.push({ x: free.x, y: free.y, w: gn.w || 240, h: gn.h || 200 });
            }
          }

          // 派发正式的批量位置更新指令（并入成交且只拖了这一个节点时可能为空）；
          // 让位成交的被挤节点并入同一条命令 = 一次撤销（拖动者+被挤枝干整体回退）
          {
            const updates = uniqueEnds.map((item) => ({
              id: item.id,
              x: item.x,
              y: item.y,
            }));
            if (pushCommit) {
              for (const [id, pos] of pushCommit.applied) {
                if (!uniqueEndsMap[id] && useCanvasStore.getState().nodes[id]) {
                  updates.push({ id, x: Math.round(pos.x), y: Math.round(pos.y) });
                }
              }
            }
            if (updates.length > 0) {
              dispatchCommand({ type: "updateNodePosition", updates });
            }
          }

          // 拖入堆叠·执行并入 + 打开目标抽屉（手机桌面式反馈：看到条目进了抽屉）
          if (mergeCmd) {
            dispatchCommand({
              type: "mergeNodeIntoStack",
              sourceId: mergeCmd.sourceId,
              targetId: mergeCmd.targetId,
            });
            useUiStore.getState().setStackDrawerNodeId(mergeCmd.targetId);
          }

          for (const item of uniqueEnds) {
            delete dragStartPositions.current[item.id];
          }

          // 聚焦被自动移走的节点（取其外接矩形中心，保持当前缩放，平滑移动视图）
          if (nudged.length > 0) {
            const minX = Math.min(...nudged.map((n) => n.x));
            const minY = Math.min(...nudged.map((n) => n.y));
            const maxX = Math.max(...nudged.map((n) => n.x + n.w));
            const maxY = Math.max(...nudged.map((n) => n.y + n.h));
            const { zoom } = getViewport();
            setCenter((minX + maxX) / 2, (minY + maxY) / 2, { zoom, duration: 400 });
          }
        } else if (pushCommit) {
          // 无有效落点（异常路径）：让位预览不提交，被挤节点回原位
          const nodesRestore = { ...useCanvasStore.getState().nodes };
          let restored = false;
          for (const [id, pos] of pushCommit.orig) {
            const n = nodesRestore[id];
            if (n) {
              nodesRestore[id] = { ...n, x: pos.x, y: pos.y };
              restored = true;
            }
          }
          if (restored) useCanvasStore.setState({ nodes: nodesRestore });
        }
      }
    },
    [scheduleDragUpdate, flushDragUpdates, setCenter, getViewport, clearStackMerge, setGuides],
  );

  return { dragStartPositions, onNodeDragStart, onNodeDrag, onNodesChange };
}
