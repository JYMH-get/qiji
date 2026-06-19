/**
 * batchExecutor — 批量生成：并行提交 N 个任务，每个任务独立轮询
 *
 * 当节点 params.quantity > 1 时，submit N 次，poll N 次，
 * 第一个成功的结果更新主节点 resultAssetId，后续结果创建 offset 子节点。
 */
import { genId } from "@/lib/id";
import type { NodePlugin } from "./pluginRegistry";
import type { Asset } from "@/store/libraryStore";

interface BatchTaskState {
  taskId: string;
  status: "queued" | "running" | "success" | "failed";
  progress: number;
  error?: string;
  resultUri?: string;
}

const BATCH_OFFSET_X = 34;
const BATCH_OFFSET_Y = 8;

export async function executeBatch(
  nodeId: string,
  quantity: number,
  plugin: NodePlugin,
) {
  const { useCanvasStore } = await import("@/store/canvasStore");
  const { useLibraryStore } = await import("@/store/libraryStore");
  const { useProjectStore } = await import("@/store/projectStore");
  const { getAdapter } = await import("@/services/modelAdapter");

  const store = useCanvasStore.getState();
  const node = store.nodes[nodeId];
  if (!node) return;

  const params = node.data.params;
  const { resolveActiveModelKey } = await import("@/services/adapters/channelAdapter");
  const modelKey = resolveActiveModelKey(node.type, params.model, plugin.defaultModel);
  const adapter = getAdapter(modelKey);
  if (!adapter) return;

  const { resolveMentions } = await import("@/lib/mentionResolver");
  const resolvedPrompt = resolveMentions(nodeId, String(params.prompt || ""));
  const inputData = { prompt: resolvedPrompt, ...(node.data.input || {}) };

  // Submit N tasks in parallel
  store.setRuntime(nodeId, { status: "queued", progress: 0 });
  const tasks: BatchTaskState[] = [];

  for (let i = 0; i < quantity; i++) {
    try {
      // Pass batch index to adapter (some adapters use it for seed variation)
      const { taskId } = await adapter.submit(inputData, { ...params, _batchIndex: i });
      tasks.push({ taskId, status: "queued", progress: 0 });
    } catch (err) {
      console.error(`Batch submit failed for index ${i}:`, err);
      tasks.push({
        taskId: `failed-${i}`,
        status: "failed",
        progress: 100,
        error: err instanceof Error ? err.message : "提交失败",
      });
    }
  }

  store.setRuntime(nodeId, { status: "running", progress: 5 });

  // Poll all tasks in parallel
  const maxPolls = 120;
  let pollCount = 0;
  let firstSuccessNodeId: string | null = null;

  const updateOverallProgress = () => {
    const totalProgress = tasks.reduce((sum, t) => sum + t.progress, 0);
    const avgProgress = Math.round(totalProgress / tasks.length);
    const allDone = tasks.every((t) => t.status === "success" || t.status === "failed");
    const anySuccess = tasks.some((t) => t.status === "success");

    if (allDone) {
      if (anySuccess) {
        store.setRuntime(nodeId, { status: "success", progress: 100 });
        useProjectStore.getState().scheduleAutoSave("history");
      } else {
        const firstError = tasks.find((t) => t.status === "failed")?.error || "全部失败";
        store.setRuntime(nodeId, { status: "failed", progress: 100, error: firstError });
      }
      return true;
    }

    store.setRuntime(nodeId, {
      status: "running",
      progress: Math.min(avgProgress, 95),
    });
    return false;
  };

  const pollTask = (index: number): Promise<void> => {
    return new Promise((resolve) => {
      const task = tasks[index];
      if (task.status === "failed") {
        resolve();
        return;
      }

      const runPoll = async () => {
        try {
          const result = await adapter.poll(task.taskId);
          task.progress = result.progress || Math.min(pollCount * 10, 95);

          if (result.status === "success") {
            task.status = "success";
            task.resultUri = result.resultUri;

            // Create asset
            const assetId = `asset-${task.taskId}`;
            const filename = `${plugin.type}_batch${index}_${Date.now()}`;

            useLibraryStore.getState().addAsset({
              id: assetId,
              kind: plugin.resultKind as Asset["kind"],
              name: filename,
              uri: result.resultUri || "",
              thumbnailUri: null,
              createdAt: new Date().toISOString(),
              deletedByUser: false,
              localPath: null,
            });

            // Update main node or create child node
            const currentNodes = useCanvasStore.getState().nodes;
            if (!firstSuccessNodeId) {
              firstSuccessNodeId = nodeId;
              const updatedNodes = { ...currentNodes };
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
            } else {
              // Create child node with offset
              const childId = genId("node");
              const childNode = {
                ...node,
                id: childId,
                x: node.x + BATCH_OFFSET_X * (index),
                y: node.y + BATCH_OFFSET_Y * (index),
                data: {
                  ...node.data,
                  resultAssetId: assetId,
                  params: { ...node.data.params, _batchIndex: index },
                },
              };
              useCanvasStore.getState().addNode(childNode);
            }
          } else if (result.status === "failed") {
            task.status = "failed";
            task.error = result.error || "生成失败";
          } else {
            task.status = "running";
          }

          updateOverallProgress();
          resolve();
        } catch (err) {
          task.status = "failed";
          task.error = err instanceof Error ? err.message : "轮询异常";
          updateOverallProgress();
          resolve();
        }
      };

      setTimeout(runPoll, 1000 + index * 200); // Stagger polls slightly
    });
  };

  // Poll all tasks concurrently
  await Promise.all(tasks.map((_, i) => pollTask(i)));

  // Continue polling if not all done
  while (!tasks.every((t) => t.status === "success" || t.status === "failed")) {
    pollCount++;
    if (pollCount >= maxPolls) {
      // Timeout
      for (const task of tasks) {
        if (task.status === "running" || task.status === "queued") {
          task.status = "failed";
          task.error = "生成超时";
        }
      }
      updateOverallProgress();
      break;
    }

    await Promise.all(
      tasks.map((task, i) => {
        if (task.status === "running" || task.status === "queued") {
          return pollTask(i);
        }
        return Promise.resolve();
      })
    );
  }
}