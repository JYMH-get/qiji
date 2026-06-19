import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "../commandBus";
import { getPlugin } from "@/nodes/pluginRegistry";
import { runMockGeneration } from "../mockGeneration";
import { dispatchCommand } from "../dispatch";

const store = () => useCanvasStore.getState();

export function registerExecutionHandlers(): void {
  commandBus.register("run", (c) => {
    if (c.type === "run") {
      store().setRuntime(c.nodeId, { status: "queued", progress: 0 });
      const node = store().nodes[c.nodeId];
      if (node) {
        const plugin = getPlugin(node.type);
        if (plugin && plugin.execute) {
          plugin.execute(c.nodeId).catch((err) => {
            console.error(`Error executing node plugin ${node.type}:`, err);
            const msg = err instanceof Error ? err.message : "执行异常";
            store().setRuntime(c.nodeId, { status: "failed", progress: 100, error: msg });
          });
        } else {
          runMockGeneration(c.nodeId);
        }
      } else {
        runMockGeneration(c.nodeId);
      }
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
    action.handler(c.nodeId, { store: s, dispatch: (cmd) => dispatchCommand(cmd as any) });
  });

  commandBus.register("schedule", (c) => {
    if (c.type === "schedule")
      store().setRuntime(c.nodeId, { status: "scheduled", scheduledAt: c.scheduledAt });
  });

  commandBus.register("cancelSchedule", (c) => {
    if (c.type === "cancelSchedule")
      store().setRuntime(c.nodeId, { status: "idle", scheduledAt: null });
  });
}

export function registerHistoryHandlers(): void {
  commandBus.register("undo", (c) => {
    if (c.type === "undo") store().undo();
  });
  commandBus.register("redo", (c) => {
    if (c.type === "redo") store().redo();
  });
}