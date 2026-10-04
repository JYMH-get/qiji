import { useProjectStore } from "@/store/projectStore";
import { useSettingsStore } from "@/store/settingsStore";
import { retryProjectBackup, useProjectBackupStore } from "@/services/projectCloudBackup";
import { useEffect, useState } from "react";
import { isProjectWriter } from "@/services/windowSync";

/** File backup status is independent of OSS media storage and local file saving. */
export function ProjectSaveStatus() {
  const id = useProjectStore(s => s.cloudBackupId);
  const isDirty = useProjectStore(s => s.isDirty);
  const isSaving = useProjectStore(s => s.isSaving);
  const savePath = useProjectStore(s => s.savePath);
  const enabled = useSettingsStore(s => s.enableCloudSync);
  const configured = useSettingsStore(s => !!s.webdavUrl.trim());
  const status = useProjectBackupStore(s => s.statuses[id]);
  const [writer, setWriter] = useState(isProjectWriter);
  useEffect(() => {
    setWriter(isProjectWriter());
    // Election also changes when another window times out without a final message.
    const timer = setInterval(() => setWriter(isProjectWriter()), 2000);
    return () => clearInterval(timer);
  }, [savePath]);
  const delegated = !!savePath && !writer;
  const local = delegated ? "由主窗口保存" : isSaving ? "本地保存中…" : isDirty || !savePath ? "待保存" : "本地已保存";
  const cloud = delegated ? "" : !enabled ? "" : !configured ? "云备份待配置" :
    status?.phase === "error" ? "云备份失败" : isDirty ? "云备份待保存" :
    status?.phase === "uploading" ? "云备份中…" : status?.phase === "waiting" ? "云备份排队中…" :
    status?.phase === "success" ? "项目文件已备份" : "云备份待保存";
  const title = [
    delegated ? "最先打开该项目的窗口负责本地保存和云备份；请在该窗口查看结果。" : status?.error,
    !delegated && status?.lastSuccessAt ? `最近备份：${new Date(status.lastSuccessAt).toLocaleString()}` : "",
    enabled ? "WebDAV 仅备份项目文件，不含本机素材" : "未开启 WebDAV 项目文件云备份",
  ].filter(Boolean).join("\n");
  return <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground" title={title} role="status">
    <span>{local}</span>
    {cloud && <span style={{ color: status?.phase === "error" ? "#f87171" : undefined }}>· {cloud}</span>}
    {!delegated && enabled && configured && status?.phase === "error" && <button
      type="button" className="text-primary hover:underline" disabled={isSaving}
      onClick={() => {
        if (useProjectStore.getState().isDirty) void useProjectStore.getState().save(true);
        else retryProjectBackup(id);
      }}
    >重试</button>}
  </span>;
}
