import { create } from "zustand";
import { useSettingsStore } from "@/store/settingsStore";
import { createProjectBackupQueue, type ProjectBackupStatus } from "./projectBackupQueue";

export function newCloudBackupId(): string {
  return `backup-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`}`;
}
export function readCloudBackupId(value: unknown): string {
  return typeof value === "string" && /^backup-[a-zA-Z0-9-]+$/.test(value) ? value : newCloudBackupId();
}
export const useProjectBackupStore = create<{ statuses: Record<string, ProjectBackupStatus> }>(() => ({ statuses: {} }));
const queue = createProjectBackupQueue(
  async (config, fileName, json) => (await import("./webdavSync")).uploadProjectFile(config, fileName, json),
  (id, status) => useProjectBackupStore.setState(s => ({ statuses: { ...s.statuses, [id]: status } })),
);
function configure() {
  const s = useSettingsStore.getState();
  queue.configure(s.enableCloudSync && s.webdavUrl.trim() ? {
    url: s.webdavUrl, directory: s.webdavDirectory, username: s.webdavUsername, password: s.webdavPassword,
  } : null);
  useProjectBackupStore.setState({ statuses: {} });
}
configure();
useSettingsStore.subscribe((next, prev) => {
  if (next.enableCloudSync !== prev.enableCloudSync || next.webdavUrl !== prev.webdavUrl ||
    next.webdavDirectory !== prev.webdavDirectory || next.webdavUsername !== prev.webdavUsername ||
    next.webdavPassword !== prev.webdavPassword) configure();
});
export const enqueueProjectBackup = (id: string, json: string) => queue.enqueue(id, json);
export const retryProjectBackup = (id: string) => queue.retry(id);
