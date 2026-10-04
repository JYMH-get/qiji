import { useCanvasStore } from "@/store/canvasStore";
import { commandBus } from "../commandBus";
import { getPlugin } from "@/nodes/pluginRegistry";
import { dispatchCommand } from "../dispatch";
import { useProjectStore, resolveEpisodeKey } from "@/store/projectStore";
import { isNodeRunBusy, isRunnableNode, type RunCommandResult } from "../nodeRunEligibility";

const store = () => useCanvasStore.getState();
const inFlight = new Set<string>();
const runScope = (nodeId: string) => {
  const ps = useProjectStore.getState();
  return JSON.stringify([ps.projectInstanceId, resolveEpisodeKey(ps.canvasEpisodeId, ps.episodes), nodeId]);
};

/** Reserve synchronously before any runtime notification/plugin call, including reentrant same-tick runs. */
function runNode(nodeId: string): RunCommandResult {
  const s = store();
  const node = s.nodes[nodeId];
  if (!node) return { started: false, reason: "missing" };
  const plugin = getPlugin(node.type);
  if (!isRunnableNode(node, plugin)) return { started: false, reason: "unavailable" };
  const scope = runScope(nodeId);
  if (inFlight.has(scope) || isNodeRunBusy(s.runtime[nodeId]?.status)) return { started: false, reason: "busy" };
  // Restored tasks are already accepted upstream; runtime is rebuilt asynchronously.
  // Failed/lost attempts may be retried, with the plugin resuming data.task instead of resubmitting.
  if (isNodeRunBusy(s.runtime[nodeId]?.status, node)) return { started: false, reason: "recovering" };
  inFlight.add(scope);
  s.setRuntime(nodeId, { status: "queued", progress: 0, error: null });
  if (runScope(nodeId) !== scope || !store().nodes[nodeId]) {
    inFlight.delete(scope);
    return { started: false, reason: "missing" };
  }
  const fail = (err: unknown) => {
    console.error(`Error executing node plugin ${node.type}:`, err);
    if (runScope(nodeId) === scope && store().nodes[nodeId]) {
      store().setRuntime(nodeId, { status: "failed", progress: 100, error: err instanceof Error ? err.message : "执行异常" });
    }
  };
  try {
    Promise.resolve(plugin!.execute!(nodeId)).catch(fail).finally(() => inFlight.delete(scope));
  } catch (err) {
    fail(err);
    // Keep the reservation through this tick even for a synchronously throwing plugin.
    queueMicrotask(() => inFlight.delete(scope));
  }
  return { started: true };
}

export function registerExecutionHandlers(): void {
  commandBus.register("run", (c) => {
    if (c.type === "run") return runNode(c.nodeId);
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
