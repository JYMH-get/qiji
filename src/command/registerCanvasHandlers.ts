import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { commandBus } from "./commandBus";
import type { CommandType } from "./commands";
import { genId } from "@/lib/id";
import { getPlugin } from "@/nodes/pluginRegistry";
import type { CanvasGroup, CanvasNode } from "@/types";
import { deleteStoredFile } from "@/services/fileStorage";
import { useProjectStore } from "@/store/projectStore";
import { dispatchCommand } from "./dispatch";

// 计算二进制内容的 SHA-256 哈希值
async function getBufferHash(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(buffer) as any,
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getTauriFsApis() {
  const { writeFile, exists, mkdir } = await import("@tauri-apps/plugin-fs");
  const { appDataDir, join } = await import("@tauri-apps/api/path");
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return { writeFile, exists, mkdir, appDataDir, join, convertFileSrc };
}

async function runMockGeneration(nodeId: string) {
  const store = useCanvasStore.getState();
  const node = store.nodes[nodeId];
  if (!node) return;

  const type = node.type;

  // Transition to running
  store.setRuntime(nodeId, { status: "running", progress: 20 });
  await new Promise((r) => setTimeout(r, 400));
  store.setRuntime(nodeId, { status: "running", progress: 60 });
  await new Promise((r) => setTimeout(r, 400));

  // Generate file content based on type
  const filename = `gen_${type}_${Date.now()}.svg`;
  const isTauri =
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

  let localPath: string | null = null;
  let fileUri = "";
  let hash = "";
  let assetId = "";

  const svgContent = `
<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200">
  <rect width="100%" height="100%" fill="#12141a" rx="10" stroke="#5b8df6" stroke-width="2"/>
  <text x="50%" y="40%" dominant-baseline="middle" text-anchor="middle" fill="#5b8df6" font-family="sans-serif" font-size="14" font-weight="bold">奇迹 (Qiji) 生成成果</text>
  <text x="50%" y="60%" dominant-baseline="middle" text-anchor="middle" fill="#98a2b3" font-family="sans-serif" font-size="11">节点类型: ${type.toUpperCase()}</text>
  <text x="50%" y="75%" dominant-baseline="middle" text-anchor="middle" fill="rgba(255,255,255,0.2)" font-family="sans-serif" font-size="9">ID: ${nodeId}</text>
</svg>
  `.trim();

  const encoder = new TextEncoder();
  const bytes = encoder.encode(svgContent);

  try {
    hash = await getBufferHash(bytes.buffer);
    assetId = `asset-${hash.slice(0, 10) || genId("asset")}`;

    if (isTauri) {
      await useProjectStore.getState().ensureProjectPath();
      const savePath = useProjectStore.getState().savePath!;
      const folder = savePath.replace(/[/\\][^/\\]+$/, "");

      const { writeFile, exists, mkdir, join, convertFileSrc } =
        await getTauriFsApis();
      const assetsDir = await join(folder, "assets");
      if (!(await exists(assetsDir))) {
        await mkdir(assetsDir, { recursive: true });
      }

      const destPath = await join(assetsDir, `${assetId}.svg`);
      await writeFile(destPath, bytes);

      localPath = destPath;
      fileUri = convertFileSrc(destPath);
    } else {
      // Browser fallback: data URL
      const blob = new Blob([svgContent], { type: "image/svg+xml" });
      fileUri = URL.createObjectURL(blob);
    }
  } catch (err) {
    console.error("Failed to generate mock asset file", err);
  }

  // Create asset in useLibraryStore
  const asset = {
    id: assetId,
    kind:
      type === "text" || type === "script"
        ? ("script" as const)
        : type === "video"
          ? ("video" as const)
          : type === "audio"
            ? ("audio" as const)
            : ("image" as const),
    name: filename,
    uri: fileUri,
    thumbnailUri: null,
    createdAt: new Date().toISOString(),
    deletedByUser: false,
    localPath,
  };

  useLibraryStore.getState().addAsset(asset);

  // Link asset to node results
  const updatedNodes = { ...store.nodes };
  if (updatedNodes[nodeId]) {
    updatedNodes[nodeId] = {
      ...updatedNodes[nodeId],
      data: {
        ...updatedNodes[nodeId].data,
        resultAssetId: assetId,
      },
    };
    useCanvasStore.setState({ nodes: updatedNodes });
  }

  // Transition to success
  store.setRuntime(nodeId, { status: "success", progress: 100 });

  // Register file ref if Tauri
  if (localPath) {
    useProjectStore.getState().addFileRef(assetId, localPath);
  }

  // Mark project dirty and trigger auto-save
  useProjectStore.getState().markDirty();
  setTimeout(() => {
    useProjectStore.getState().save();
  }, 100);
}

let registered = false;

/**
 * 把命令处理器接到画布 store 上。GUI / Copilot / Agent 三入口最终都在这里落库。
 * 模块级单次注册（StrictMode 双调用安全）。
 */
export function registerCanvasHandlers(): void {
  if (registered) return;
  registered = true;
  const store = () => useCanvasStore.getState();

  commandBus.register("addNode", (c) => {
    if (c.type !== "addNode") return;
    const s = store();
    s.addNode(c.node);

    if (c.node.parentId) {
      const freshStore = store();
      const groupId = c.node.parentId;
      const group = freshStore.groups[groupId];
      if (group) {
        // Add to childIds if not present
        const childIds = group.childIds.includes(c.node.id)
          ? group.childIds
          : [...group.childIds, c.node.id];

        const updatedGroups = {
          ...freshStore.groups,
          [groupId]: {
            ...group,
            childIds,
          },
        };

        // Recalculate group bounds to encompass the new node
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
            ...updatedGroups[groupId],
            x: groupX,
            y: groupY,
          };
        }

        useCanvasStore.setState({
          nodes: updatedNodes,
          groups: updatedGroups,
        });
      }
    }
  });
  commandBus.register("updateNodePosition", (c) => {
    if (c.type !== "updateNodePosition") return;
    const s = store();
    for (const u of c.updates) {
      s.moveNode(u.id, u.x, u.y);
    }

    // 检查是否有子节点被移动，若有则重新计算并更新其所属的分组大小与位置
    const groupsToUpdate = new Set<string>();
    for (const u of c.updates) {
      const node = store().nodes[u.id];
      if (node && node.parentId) {
        groupsToUpdate.add(node.parentId);
      }
    }

    if (groupsToUpdate.size > 0) {
      const updatedNodes = { ...store().nodes };
      const updatedGroups = { ...store().groups };

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
  });
  commandBus.register("resizeNode", (c) => {
    if (c.type === "resizeNode") store().resizeNode(c.id, c.w, c.h);
  });
  commandBus.register("updateNodeParams", (c) => {
    if (c.type === "updateNodeParams") store().updateNodeParams(c.id, c.params);
  });
  commandBus.register("deleteNode", (c) => {
    if (c.type === "deleteNode") {
      const node = store().nodes[c.id];
      if (node && node.type === "file") {
        const params = node.data?.params ?? {};
        const localPath =
          typeof params.localPath === "string" ? params.localPath : null;
        const fileId = typeof params.fileId === "string" ? params.fileId : null;
        if (localPath) {
          deleteStoredFile(localPath);
        }
        if (fileId) {
          useProjectStore.getState().removeFileRef(fileId);
        }
      }
      store().removeNode(c.id);
    }
  });
  commandBus.register("connect", (c) => {
    if (c.type === "connect") store().addEdge(c.edge);
  });
  commandBus.register("disconnect", (c) => {
    if (c.type === "disconnect") store().removeEdge(c.edgeId);
  });
  commandBus.register("run", (c) => {
    if (c.type === "run") {
      store().setRuntime(c.nodeId, { status: "queued", progress: 0 });
      runMockGeneration(c.nodeId);
    }
  });
  commandBus.register("executeNodeAction", (c) => {
    if (c.type !== "executeNodeAction") return;
    const s = store();
    const node = s.nodes[c.nodeId];
    if (!node) return;
    const plugin = getPlugin(node.type);
    const action = plugin?.actions?.find((a) => a.name === c.actionName);
    if (!action) return;
    action.handler(c.nodeId, { store: s, dispatch: dispatchCommand });
  });
  commandBus.register("setNodeResultAsset", (c) => {
    if (c.type !== "setNodeResultAsset") return;
    const s = store();
    const node = s.nodes[c.nodeId];
    if (node) {
      const updatedNodes = { ...s.nodes };
      updatedNodes[c.nodeId] = {
        ...node,
        data: {
          ...node.data,
          resultAssetId: c.assetId,
        },
      };
      useCanvasStore.setState({ nodes: updatedNodes });
    }
  });
  commandBus.register("schedule", (c) => {
    if (c.type === "schedule")
      store().setRuntime(c.nodeId, {
        status: "scheduled",
        scheduledAt: c.scheduledAt,
      });
  });
  commandBus.register("cancelSchedule", (c) => {
    if (c.type === "cancelSchedule")
      store().setRuntime(c.nodeId, { status: "idle", scheduledAt: null });
  });

  // Phase 2 结构撤销/重做处理器
  commandBus.register("undo", (c) => {
    if (c.type === "undo") store().undo();
  });
  commandBus.register("redo", (c) => {
    if (c.type === "redo") store().redo();
  });

  // Phase 2 中段插入处理器
  commandBus.register("insertOnEdge", (c) => {
    if (c.type !== "insertOnEdge") return;
    const s = store();
    const oldEdge = s.edges[c.edgeId];
    if (!oldEdge) return;

    // 1. 添加新节点
    s.addNode(c.node);

    // 2. 删除老连线
    s.removeEdge(c.edgeId);

    // 3. 补齐上游连线
    const nodeTypeDef = getPlugin(c.nodeType);
    if (nodeTypeDef && nodeTypeDef.inputs.length > 0) {
      s.addEdge({
        id: genId("edge"),
        kind: "dataflow",
        source: oldEdge.source,
        sourcePort: oldEdge.sourcePort,
        target: c.node.id,
        targetPort: nodeTypeDef.inputs[0].name,
      });
    }

    // 4. 补齐下游连线
    if (nodeTypeDef && nodeTypeDef.outputs.length > 0) {
      s.addEdge({
        id: genId("edge"),
        kind: "dataflow",
        source: c.node.id,
        sourcePort: nodeTypeDef.outputs[0].name,
        target: oldEdge.target,
        targetPort: oldEdge.targetPort,
      });
    }
  });

  // Phase 2 打组处理器
  commandBus.register("group", (c) => {
    if (c.type !== "group" || c.nodeIds.length < 2) return;
    const s = store();
    const nodes = c.nodeIds.map((id) => s.nodes[id]).filter(Boolean);
    if (nodes.length < 2) return;

    // 计算外接矩形
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const xMaxs = nodes.map((n) => n.x + n.w);
    const yMaxs = nodes.map((n) => n.y + n.h);
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

    const groupId = genId("group");

    // 创建 group 节点（以供 React Flow 渲染组背景）
    const groupNode: CanvasNode = {
      id: groupId,
      type: "group",
      x: groupX,
      y: groupY,
      w: groupW,
      h: groupH,
      parentId: null,
      parentScriptId: null,
      data: {
        input: {},
        params: {},
        resultAssetId: null,
        sourceVersion: 0,
      },
    };
    s.addNode(groupNode);

    // 将子节点 parentId 指向该分组，保留绝对坐标，不进行相对坐标转换
    const updatedNodes = { ...store().nodes };
    for (const node of nodes) {
      updatedNodes[node.id] = {
        ...node,
        parentId: groupId,
      };
    }
    useCanvasStore.setState({ nodes: updatedNodes });

    // 保存分组数据模型
    const newGroup: CanvasGroup = {
      id: groupId,
      childIds: c.nodeIds,
      x: groupX,
      y: groupY,
    };
    s.setGroups({ ...s.groups, [groupId]: newGroup });
  });

  // Phase 2 解组处理器
  commandBus.register("ungroup", (c) => {
    if (c.type !== "ungroup") return;
    const s = store();

    if (c.nodeId) {
      // 单个解组 (Ungroup a single node from the group)
      const targetNodeId = c.nodeId;
      const groupId = c.groupId;
      const group = s.groups[groupId];
      if (!group) return;

      const remainingNodeIds = group.childIds.filter(
        (id) => id !== targetNodeId,
      );
      if (remainingNodeIds.length < 2) {
        // 如果只剩下不到 2 个节点，整个组自动解散
        s.removeNode(groupId);
      } else {
        // 重新计算其余子节点的外接矩形
        const remainingNodes = remainingNodeIds
          .map((id) => s.nodes[id])
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

          const updatedNodes = { ...s.nodes };
          // 移出节点
          if (updatedNodes[targetNodeId]) {
            updatedNodes[targetNodeId] = {
              ...updatedNodes[targetNodeId],
              parentId: null,
            };
          }
          // 更新 group 节点几何大小与位置
          if (updatedNodes[groupId]) {
            updatedNodes[groupId] = {
              ...updatedNodes[groupId],
              x: groupX,
              y: groupY,
              w: groupW,
              h: groupH,
            };
          }

          const updatedGroups = { ...s.groups };
          updatedGroups[groupId] = {
            ...updatedGroups[groupId],
            childIds: remainingNodeIds,
            x: groupX,
            y: groupY,
          };

          useCanvasStore.setState({
            nodes: updatedNodes,
            groups: updatedGroups,
          });
        } else {
          s.removeNode(groupId);
        }
      }
    } else {
      // 全部解组 (Ungroup all)
      s.removeNode(c.groupId);
    }
  });

  // Phase 5 结构命令占位：先注册避免「未注册处理器」告警，后续接入。
  const laterCommands: CommandType[] = ["burstScript"];
  for (const t of laterCommands) {
    commandBus.register(t, (c) => {
      console.info(`[Phase later] 命令暂未实现: ${c.type}`);
    });
  }
}
