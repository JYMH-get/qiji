/**
 * projectFile.ts — .Qiji 项目文件序列化 / 反序列化
 *
 * 格式：JSON，支持类似 Git 的历史提交记录与分支指针模型。
 * Tauri 环境：直接读写磁盘 .Qiji 文件。
 * 浏览器降级：JSON 下载 / File API 读取。
 */
import type { CanvasNode, CanvasEdge, CanvasGroup } from "@/types";

export const Qiji_VERSION = "2.0";
export const FILE_EXT = ".Qiji";

export interface CommitSnapshot {
  commitId: string;
  parentIds: string[];
  message: string;
  author: string;
  timestamp: string;
  canvas: {
    nodes: Record<string, CanvasNode>;
    edges: Record<string, CanvasEdge>;
    groups: Record<string, CanvasGroup>;
    viewport?: { x: number; y: number; zoom: number };
  };
  assets?: Record<string, any>;
}

export interface QijiProject {
  version: string;
  name: string;
  savedAt: string;
  head: string; // 当前指向的 commitId
  commits: Record<string, CommitSnapshot>; // 历史版本快照字典
  /** fileId → localPath */
  files: Record<string, string | null>;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function getTauriFs() {
  const { writeTextFile, readTextFile } = await import("@tauri-apps/plugin-fs");
  const { save, open } = await import("@tauri-apps/plugin-dialog");
  const { documentDir, join } = await import("@tauri-apps/api/path");
  return { writeTextFile, readTextFile, save, open, documentDir, join };
}

/**
 * 迁移兼容：将 1.0 版本的旧项目数据平滑转化为版本快照结构
 */
export function migrateProject(oldProj: any): QijiProject {
  if (oldProj.commits && oldProj.head) {
    return oldProj as QijiProject;
  }

  const initialCommitId = "commit-init";
  const initialCommit: CommitSnapshot = {
    commitId: initialCommitId,
    parentIds: [],
    message: "迁移自旧版本项目",
    author: "System",
    timestamp: oldProj.savedAt || new Date().toISOString(),
    canvas: oldProj.canvas || { nodes: {}, edges: {}, groups: {}, viewport: { x: 0, y: 0, zoom: 1 } },
    assets: oldProj.assets || {},
  };

  return {
    version: Qiji_VERSION,
    name: oldProj.name || "未命名项目",
    savedAt: oldProj.savedAt || new Date().toISOString(),
    head: initialCommitId,
    commits: {
      [initialCommitId]: initialCommit,
    },
    files: oldProj.files || {},
  };
}

/**
 * 将 QijiProject 序列化为 JSON 写入磁盘或触发浏览器下载。
 */
export async function saveProject(
  project: QijiProject,
  existingPath?: string | null,
): Promise<string | null> {
  project.version = Qiji_VERSION;
  project.savedAt = new Date().toISOString();
  const json = JSON.stringify(project, null, 2);

  if (isTauri()) {
    const { writeTextFile, save, documentDir, join } = await getTauriFs();

    let filePath = existingPath;
    if (!filePath) {
      const defaultPath = await join(await documentDir(), "Qiji", `${project.name}${FILE_EXT}`);
      filePath = await save({
        defaultPath,
        filters: [{ name: "Qiji 项目", extensions: ["Qiji"] }],
      }) as string | null;
    }
    if (!filePath) return null;

    await writeTextFile(filePath, json);
    return filePath;
  }

  // 浏览器降级：触发 JSON 下载
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${project.name}${FILE_EXT}`;
  a.click();
  URL.revokeObjectURL(url);
  return null;
}

/**
 * 弹出文件对话框，读取并解析 .Qiji 项目文件，自动做版本兼容迁移。
 */
export async function openProject(): Promise<{ project: QijiProject; path: string } | null> {
  if (isTauri()) {
    const { readTextFile, open } = await getTauriFs();
    const selected = await open({
      multiple: false,
      filters: [{ name: "Qiji 项目", extensions: ["Qiji"] }],
    }) as string | null;
    if (!selected) return null;
    const json = await readTextFile(selected);
    const parsed = JSON.parse(json);
    return { project: migrateProject(parsed), path: selected };
  }

  // 浏览器降级：<input type=file>
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = FILE_EXT + ",application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string);
          resolve({ project: migrateProject(parsed), path: file.name });
        } catch {
          resolve(null);
        }
      };
      reader.readAsText(file);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * 直接从指定路径读取项目（启动时恢复上次项目），自动做版本兼容迁移。
 */
export async function loadProjectFromPath(path: string): Promise<QijiProject | null> {
  if (!isTauri()) return null;
  try {
    const { readTextFile } = await getTauriFs();
    const json = await readTextFile(path);
    const parsed = JSON.parse(json);
    return migrateProject(parsed);
  } catch {
    return null;
  }
}
