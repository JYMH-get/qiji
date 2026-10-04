import type { CanvasNode, RuntimeStatus } from "@/types";
import type { NodePlugin } from "@/nodes/pluginRegistry";

/** Shared by visible run controls and the command handler. Seed/upload/results are inputs, not jobs. */
export function isRunnableNode(node: CanvasNode | null | undefined, plugin: NodePlugin | undefined): boolean {
  return !!node && node.type !== "group" && node.data.params?.resultOnly !== true
    && !!plugin?.execute && plugin.nodeKind !== "upload" && plugin.nodeKind !== "seed";
}

export function isNodeRunBusy(status: RuntimeStatus | undefined, node?: CanvasNode | null): boolean {
  return status === "queued" || status === "running"
    || (!!node?.data.task?.taskId && !!node.data.task.adapterKey && status !== "failed");
}

export interface RunCommandResult {
  started: boolean;
  reason?: "busy" | "recovering" | "unavailable" | "missing";
}
