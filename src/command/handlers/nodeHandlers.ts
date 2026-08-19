import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { avoidOverlap, makeNode, NODE_W, NODE_H } from "@/canvas/nodeFactory";
import { fanOutSharedParams } from "@/lib/sharedNodeParams";
import { commandBus } from "../commandBus";

const store = () => useCanvasStore.getState();

export function registerNodeHandlers(): void {
  commandBus.register("addNode", (c) => {
    if (c.type !== "addNode") return;
    const s = store();
    // 不重合：顶层节点(无 parent)若与现有节点相交，沿对角线错位到空位再落子；
    // 分组内子节点保持给定位置（粘贴/裂变/投影走各自命令与布局，不经此）。
    // 「重叠」开关（allowOverlap）开着时不避让，按给定坐标原样落子。
    const node = c.node.parentId || useUiStore.getState().allowOverlap
      ? c.node
      : avoidOverlap(c.node, Object.values(s.nodes));
    s.addNode(node);

    if (node.parentId) {
      const freshStore = store();
      const groupId = node.parentId;
      const group = freshStore.groups[groupId];
      if (group) {
        const childIds = group.childIds.includes(node.id)
          ? group.childIds
          : [...group.childIds, node.id];

        const updatedGroups = {
          ...freshStore.groups,
          [groupId]: { ...group, childIds },
        };

        const updatedNodes = { ...freshStore.nodes };
        const remainingNodes = childIds
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
              x: groupX, y: groupY, w: groupW, h: groupH,
            };
          }
          updatedGroups[groupId] = { ...updatedGroups[groupId], x: groupX, y: groupY };
        }

        useCanvasStore.setState({ nodes: updatedNodes, groups: updatedGroups });
      }
    }
  });

  commandBus.register("updateNodePosition", (c) => {
    if (c.type !== "updateNodePosition") return;
    // 单次合并 setState：整理画布/多选拖动收尾可能带几十条更新，逐条 moveNode 会触发同样次数的
    // 全订阅者重算（多选拖动卡顿同源，见 useCanvasDrag.flushDragUpdates 注释）。
    const s = store();
    const nodes = { ...s.nodes };
    let changed = false;
    for (const u of c.updates) {
      const n = nodes[u.id];
      if (!n) continue;
      // 可选携带尺寸（整理画布时为文本主干按支线数增高）
      nodes[u.id] =
        u.w !== undefined && u.h !== undefined
          ? { ...n, x: u.x, y: u.y, w: u.w, h: u.h }
          : { ...n, x: u.x, y: u.y };
      changed = true;
    }
    if (changed) useCanvasStore.setState({ nodes });

    const groupsToUpdate = new Set<string>();
    for (const u of c.updates) {
      const node = store().nodes[u.id];
      if (node && node.parentId) groupsToUpdate.add(node.parentId);
    }

    if (groupsToUpdate.size > 0) {
      const updatedNodes = { ...store().nodes };
      const updatedGroups = { ...store().groups };

      for (const groupId of groupsToUpdate) {
        const group = updatedGroups[groupId];
        if (!group) continue;
        const remainingNodes = group.childIds.map((id) => updatedNodes[id]).filter(Boolean);
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
            updatedNodes[groupId] = { ...updatedNodes[groupId], x: groupX, y: groupY, w: groupW, h: groupH };
          }
          updatedGroups[groupId] = { ...group, x: groupX, y: groupY };
        }
      }
      useCanvasStore.setState({ nodes: updatedNodes, groups: updatedGroups });
    }
  });

  commandBus.register("resizeNode", (c) => {
    if (c.type === "resizeNode") store().resizeNode(c.id, c.w, c.h);
  });

  commandBus.register("updateNodeParams", (c) => {
    if (c.type !== "updateNodeParams") return;
    store().updateNodeParams(c.id, c.params);
    // 同类型节点共享设置（输出一致性）：变更里的共享键（比例/分辨率/模型等）
    // 扇出到同画布其余同类型节点；prompt 等内容字段不扇出，处理类节点不参与。
    fanOutSharedParams(c.id, c.params);
  });

  // 裂变：父节点成功后批量创建子节点 + 连线（一次命令 = 一次撤销栈条目）。
  // 走 store.addNode（自动 seed runtime 默认值），子节点带 prompt/resultText 但不运行。
  commandBus.register("spawnNodes", (c) => {
    if (c.type !== "spawnNodes") return;
    const s = store();
    for (const node of c.nodes) s.addNode(node);
    for (const edge of c.edges) s.addEdge(edge);
    // 严格不重叠：被落位压到的已有节点按预算好的让位坐标一并更新（单次 setState，随本命令一次撤销）
    if (c.pushed?.length) {
      const nodes = { ...store().nodes };
      let changed = false;
      for (const u of c.pushed) {
        const n = nodes[u.id];
        if (n && (n.x !== u.x || n.y !== u.y)) {
          nodes[u.id] = { ...n, x: u.x, y: u.y };
          changed = true;
        }
      }
      if (changed) useCanvasStore.setState({ nodes });
    }
  });

  commandBus.register("setNodeResultAsset", (c) => {
    if (c.type !== "setNodeResultAsset") return;
    const s = store();
    const node = s.nodes[c.nodeId];
    if (node) {
      const updatedNodes = { ...s.nodes };
      updatedNodes[c.nodeId] = {
        ...node,
        data: { ...node.data, resultAssetId: c.assetId },
      };
      useCanvasStore.setState({ nodes: updatedNodes });
    }
  });

  // 自定义结果：把（已上传好的）资产追加为节点结果——已有主图归档进堆叠历史（去重、旧→新），
  // 新资产依次入历史，最后一个设为主图。上传本身在 UI 层完成，这里只做纯数据变更（一次撤销）。
  commandBus.register("addNodeResults", (c) => {
    if (c.type !== "addNodeResults") return;
    const s = store();
    const node = s.nodes[c.nodeId];
    const ids = c.assetIds.filter(Boolean);
    if (!node || ids.length === 0) return;
    const hist = [...(node.data.resultHistory ?? [])];
    if (node.data.resultAssetId && !hist.includes(node.data.resultAssetId)) {
      hist.push(node.data.resultAssetId);
    }
    for (const a of ids) {
      if (!hist.includes(a)) hist.push(a);
    }
    useCanvasStore.setState({
      nodes: {
        ...s.nodes,
        [c.nodeId]: {
          ...node,
          data: { ...node.data, resultAssetId: ids[ids.length - 1], resultHistory: hist },
        },
      },
    });
  });

  // 抽屉式堆叠·并入：source 节点的结果资产（含其自身堆叠历史）追加进 target 的 resultHistory
  // （去重、保持旧→新顺序，target 主图不变），然后删除 source 节点（连线级联删除）。
  commandBus.register("mergeNodeIntoStack", (c) => {
    if (c.type !== "mergeNodeIntoStack") return;
    if (c.sourceId === c.targetId) return;
    const s = store();
    const src = s.nodes[c.sourceId];
    const tgt = s.nodes[c.targetId];
    if (!src || !tgt) return;

    // source 携带的全部资产：历史（旧→新）+ 主图兜底
    const srcAssets = [...(src.data.resultHistory ?? [])];
    if (src.data.resultAssetId && !srcAssets.includes(src.data.resultAssetId)) {
      srcAssets.push(src.data.resultAssetId);
    }
    if (srcAssets.length === 0) return;

    // target 历史确保含自己主图（老节点可能只有 resultAssetId 没有 history）
    const hist = [...(tgt.data.resultHistory ?? [])];
    if (tgt.data.resultAssetId && !hist.includes(tgt.data.resultAssetId)) {
      hist.push(tgt.data.resultAssetId);
    }
    for (const a of srcAssets) {
      if (!hist.includes(a)) hist.push(a);
    }

    useCanvasStore.setState({
      nodes: {
        ...s.nodes,
        [c.targetId]: { ...tgt, data: { ...tgt.data, resultHistory: hist } },
      },
    });
    store().removeNode(c.sourceId);
  });

  // 分镜组·创建：UI 侧组装好节点（buildShotGroupNode）→ 这里落子；被合并的源图片节点
  // 一并删除（连线级联），一次撤销恢复全部。
  commandBus.register("createShotGroup", (c) => {
    if (c.type !== "createShotGroup") return;
    for (const id of c.deleteSourceIds ?? []) store().removeNode(id);
    const remain = Object.values(store().nodes);
    const node = useUiStore.getState().allowOverlap ? c.node : avoidOverlap(c.node, remain);
    store().addNode(node);
  });

  // 重组文本（拆分的逆）：删除被合并的源文本节点（连线级联）+ 落一个新原文节点，一次撤销。
  commandBus.register("mergeTextNodes", (c) => {
    if (c.type !== "mergeTextNodes") return;
    for (const id of c.deleteSourceIds ?? []) store().removeNode(id);
    const remain = Object.values(store().nodes);
    const node = useUiStore.getState().allowOverlap ? c.node : avoidOverlap(c.node, remain);
    store().addNode(node);
  });

  // 分镜组·整组替换宫格资产列表（拖动排序/清空）
  commandBus.register("updateShotGroup", (c) => {
    if (c.type !== "updateShotGroup") return;
    const s = store();
    const n = s.nodes[c.nodeId];
    if (!n || n.type !== "shot.group") return;
    useCanvasStore.setState({
      nodes: { ...s.nodes, [c.nodeId]: { ...n, data: { ...n.data, shotAssets: [...c.assets] } } },
    });
  });

  // 分镜组·解组：每张图裂变一个 image.gen 节点（按组的宫格列数在右侧铺开），删除分镜组节点。
  commandBus.register("dissolveShotGroup", (c) => {
    if (c.type !== "dissolveShotGroup") return;
    const s = store();
    const n = s.nodes[c.nodeId];
    if (!n || n.type !== "shot.group") return;
    const assets = n.data.shotAssets ?? [];
    const colsRaw = Math.round(Number(n.data.params?.gridCols));
    const cols = Number.isFinite(colsRaw) && colsRaw >= 1 ? colsRaw : 2;
    const startX = n.x + (n.w || NODE_W) + 64;
    assets.forEach((aid, i) => {
      const child = makeNode(
        "image.gen",
        startX + (i % cols) * (NODE_W + 24),
        n.y + Math.floor(i / cols) * (NODE_H + 24),
      );
      child.data.resultAssetId = aid;
      child.data.resultHistory = [aid];
      child.data.params = { ...child.data.params, prompt: `分镜组解组 · 第 ${i + 1} 格` };
      store().addNode(child);
    });
    store().removeNode(c.nodeId);
  });

  // 分镜组·单独解除：把第 index 格移出宫格 + 裂变一个 image.gen 节点承载（组节点保留，一次撤销）
  commandBus.register("extractShotGroupItem", (c) => {
    if (c.type !== "extractShotGroupItem") return;
    const s = store();
    const n = s.nodes[c.nodeId];
    if (!n || n.type !== "shot.group") return;
    const assets = n.data.shotAssets ?? [];
    const aid = assets[c.index];
    if (!aid) return;
    useCanvasStore.setState({
      nodes: {
        ...s.nodes,
        [c.nodeId]: { ...n, data: { ...n.data, shotAssets: assets.filter((_, i) => i !== c.index) } },
      },
    });
    const child = makeNode("image.gen", n.x + (n.w || NODE_W) + 64, n.y);
    child.data.resultAssetId = aid;
    child.data.resultHistory = [aid];
    child.data.params = { ...child.data.params, prompt: `分镜组解除 · 第 ${c.index + 1} 格` };
    store().addNode(child);
  });
}