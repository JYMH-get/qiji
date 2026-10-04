import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "../commandBus";
import { useUiStore } from "@/store/uiStore";

const store = () => useCanvasStore.getState();

function deleteNode(id: string): void {
  const node = store().nodes[id];
  if (!node) return;
  // A structural undo restores this node's asset references. Keep the backing file and
  // project reference here; deleting a canvas node is not deleting the project's asset.
  store().removeNode(id);
}

export function registerDeleteHandlers(): void {
  commandBus.register("deleteNode", (c) => {
    if (c.type === "deleteNode") deleteNode(c.id);
  });
  commandBus.register("deleteElements", (c) => {
    if (c.type !== "deleteElements") return;
    for (const id of new Set(c.nodeIds ?? [])) deleteNode(id);
    for (const id of new Set(c.edgeIds ?? [])) if (store().edges[id]) store().removeEdge(id);
    const s = store();
    const ui = useUiStore.getState();
    ui.setSelection(ui.selectedNodeIds.filter((id) => !!s.nodes[id]));
    ui.setEdgeSelection(ui.selectedEdgeIds.filter((id) => !!s.edges[id]));
    if (ui.activeNodeId && !s.nodes[ui.activeNodeId]) ui.setActiveNodeId(null);
  });
}
