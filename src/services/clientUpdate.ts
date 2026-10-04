import { create } from "zustand";
import { ClientUpdateController, INITIAL_UPDATE_STATE } from "./clientUpdateCore";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useRequestLedgerStore } from "@/store/requestLedgerStore";
import { usePromptModalStore } from "@/store/promptModalStore";
import { useAnnotationStore } from "@/store/annotationStore";
import { useViewAngleStore } from "@/store/viewAngleStore";
import { useDirectorStore } from "@/store/directorStore";
import { isProjectWriter } from "./windowSync";
import { hasTrackedTasks } from "./taskCenter";
import { hasClientActivity } from "./clientUpdateActivity";
import type { CanvasNode } from "@/types";

export const useClientUpdateStore = create(() => ({ ...INITIAL_UPDATE_STATE }));
export const isDesktopClient = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function onlyWindow() {
  const { getAllWebviewWindows, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const windows = await getAllWebviewWindows();
  if (windows.some(w => w.label !== getCurrentWebviewWindow().label)) {
    throw new Error("请先保存并关闭其他 Qiji 窗口和独立助手窗口，再安装更新");
  }
}

function assertIdle() {
  const p = useProjectStore.getState();
  if (p.isSaving || p.isProjectLoading) throw new Error("项目正在保存或加载，请稍后再安装");
  const active = (n: CanvasNode) => !!n.data.task;
  if (hasClientActivity() || hasTrackedTasks() || p.analysisRunning || p.pendingGens.some(g => g.status === "running")
    || p.inferTasks.some(t => t.status === "running") || Object.values(useCanvasStore.getState().nodes).some(active)
    || Object.values(useCanvasStore.getState().runtime).some(r => ["running", "queued", "scheduled", "uploading"].includes(r.status))
    || Object.values(p.canvases).some(c => Object.values(c.nodes).some(active))
    || Object.values(p.rtcDocs).some(d => [d, ...Object.values(d.subDocs || {})].some(doc => doc.tracks.some(t => t.segments.some(s => s.status === "running"))))
    || useRequestLedgerStore.getState().entries.some(e => e.status === "pending")) {
    throw new Error("仍有生成、分析或排队任务，请完成后再安装更新");
  }
  if (usePromptModalStore.getState().open || useAnnotationStore.getState().session
    || useViewAngleStore.getState().session || useDirectorStore.getState().session) {
    throw new Error("请先保存并关闭当前编辑弹窗，再安装更新");
  }
  if (p.savePath && !isProjectWriter()) throw new Error("正在切换项目写入窗口，请稍后重试");
}

export async function prepareClientUpdate() {
  await onlyWindow();
  assertIdle();
  const p = useProjectStore.getState();
  if (p.savePath || p.isDirty) {
    // save() 的旧接口吞异常；先标脏，必须观察到成功保存的 clean 状态才允许退出。
    p.markDirty();
    await useProjectStore.getState().save(true);
    const saved = useProjectStore.getState();
    if (saved.isDirty || saved.isSaving || !saved.savePath) throw new Error("项目未能保存，已暂停安装。请先手动保存成功后重试");
  }
  await onlyWindow();
  assertIdle();
  await (await import("@tauri-apps/api/core")).invoke("set_client_update_installing", { enabled: true });
}

export const clientUpdate = new ClientUpdateController({
  check: async () => {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 20_000, headers: { "Cache-Control": "no-cache" } });
    if (!update) return null;
    return {
      version: update.version, body: update.body,
      download: callback => update.download(callback, { timeout: 30 * 60_000 }),
      install: () => update.install({ restartAfterInstall: true }), close: () => update.close(),
    };
  },
  prepare: prepareClientUpdate,
  relaunch: async () => { await (await import("@tauri-apps/plugin-process")).relaunch(); },
  release: async () => { await (await import("@tauri-apps/api/core")).invoke("set_client_update_installing", { enabled: false }); },
}, state => useClientUpdateStore.setState(state));

/** 每 4 小时检查；多个窗口只由最先的主窗口自动下载，关闭后由下一窗口接管。 */
export function startClientUpdates() {
  if (!isDesktopClient() || import.meta.env.DEV) return () => {};
  let stopped = false;
  const check = async () => {
    try {
      const { getAllWebviewWindows, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const windows = (await getAllWebviewWindows()).filter(w => /^main(?:-|$)/.test(w.label)).sort((a,b) => a.label.localeCompare(b.label));
      if (!stopped && windows[0]?.label === getCurrentWebviewWindow().label) await clientUpdate.check();
    } catch { /* 自动检测失败不打断用户工作；手动入口可重试。 */ }
  };
  const startup = setTimeout(() => void check(), 15_000);
  const interval = setInterval(() => void check(), 4 * 60 * 60_000);
  return () => { stopped = true; clearTimeout(startup); clearInterval(interval); };
}
