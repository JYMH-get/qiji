import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "../commandBus";

const store = () => useCanvasStore.getState();

export function registerNodeHandlers(): void {
  commandBus.register("addNode", (c) => {
    if (c.type !== "addNode") return;
    const s = store();
    s.addNode(c.node);

    if (c.node.parentId) {
      const freshStore = store();
      const groupId = c.node.parentId;
      const group = freshStore.groups[groupId];
      if (group) {
        const childIds = group.childIds.includes(c.node.id)
          ? group.childIds
          : [...group.childIds, c.node.id];

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
    const s = store();
    for (const u of c.updates) {
      s.moveNode(u.id, u.x, u.y);
    }

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
    if (c.type === "updateNodeParams") store().updateNodeParams(c.id, c.params);
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
}