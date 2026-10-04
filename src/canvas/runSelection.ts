import { create } from "zustand";
import { dispatchCommand } from "@/command/dispatch";

export interface RunSelectionSummary { started: number; skipped: number }
export const useRunSelectionFeedback = create<{ message: string | null; revision: number }>(() => ({ message: null, revision: 0 }));

/** Count command acceptance, not selected-node count or eventual paid generation success. */
export function runSelectedNodes(nodeIds: readonly string[]): RunSelectionSummary {
  const ids = [...new Set(nodeIds)];
  const summary = { started: 0, skipped: 0 };
  let reason: string | undefined;
  for (const nodeId of ids) {
    const result = dispatchCommand({ type: "run", nodeId });
    if (result?.started) summary.started++;
    else { summary.skipped++; reason = result?.reason; }
  }
  if (ids.length > 1 || summary.skipped) {
    const message = ids.length > 1
      ? `已启动 ${summary.started} 个，已跳过 ${summary.skipped} 个`
      : reason === "busy" ? "节点正在运行，已跳过" : reason === "recovering" ? "正在找回已有任务，已跳过" : "此节点无法运行，已跳过";
    useRunSelectionFeedback.setState((s) => ({ message, revision: s.revision + 1 }));
  }
  return summary;
}
