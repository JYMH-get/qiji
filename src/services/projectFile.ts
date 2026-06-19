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
  assets?: Record<string, import("@/store/libraryStore").Asset>;
}

export interface MigrationLogEntry {
  fromVersion: string;
  toVersion: string;
  migratedAt: string;
  description: string;
}

export interface QijiProject {
  version: string;
  name: string;
  savedAt: string;
  head: string;
  commits: Record<string, CommitSnapshot>;
  files: Record<string, string | null>;
  /** 迁移日志，记录版本升级历史 */
  migrationLog?: MigrationLogEntry[];
  scriptText?: string;
  visualStyle?: string;
  characters?: Array<{ id: string; name: string; features: string; philosophy: string; prompt: string; image?: string }>;
  scenes?: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string }>;
  items?: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string }>;
  organisms?: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string }>;
  isAnalyzed?: boolean;
  analysisTime?: string;
  projectModelConfig?: {
    tableText?: string;
    tableImage?: string;
    tableVideo?: string;
    tableAudio?: string;
    canvasText?: string;
    canvasImage?: string;
    canvasVideo?: string;
    canvasAudio?: string;
  };
  /** Legacy v1.x 顶层字段（兼容旧格式读取） */
  nodes?: Record<string, CanvasNode>;
  edges?: Record<string, CanvasEdge>;
  groups?: Record<string, CanvasGroup>;
  viewport?: { x: number; y: number; zoom: number };
  assets?: Record<string, import("@/store/libraryStore").Asset>;
  canvas?: CommitSnapshot["canvas"];
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
 * 版本迁移注册表：从 v1.x 到 v2.0 的迁移函数
 */
interface MigrationFunction {
  (project: any): any;
}

const migrations: Record<string, MigrationFunction> = {
  // v1.x -> v2.0: 引入 commits 历史快照结构
  "1.x-to-2.0": (oldProj: any) => {
    const initialCommitId = "commit-init";
    const initialCommit: CommitSnapshot = {
      commitId: initialCommitId,
      parentIds: [],
      message: "从 v1.x 迁移",
      author: "System",
      timestamp: oldProj.savedAt || new Date().toISOString(),
      canvas: oldProj.canvas || {
        nodes: oldProj.nodes || {},
        edges: oldProj.edges || {},
        groups: oldProj.groups || {},
        viewport: oldProj.viewport || { x: 0, y: 0, zoom: 1 },
      },
      assets: oldProj.assets || {},
    };

    return {
      version: "2.0",
      name: oldProj.name || "未命名项目",
      savedAt: oldProj.savedAt || new Date().toISOString(),
      head: initialCommitId,
      commits: { [initialCommitId]: initialCommit },
      files: oldProj.files || {},
      migrationLog: [
        {
          fromVersion: oldProj.version || "1.x",
          toVersion: "2.0",
          migratedAt: new Date().toISOString(),
          description: "引入 commits 历史快照结构，支持版本回滚",
        },
      ],
    };
  },
};

/**
 * 迁移兼容：将旧版本项目数据平滑转化为最新版本结构
 */
export function migrateProject(oldProj: any): QijiProject {
  // 如果已经是 v2.0+ 且包含 commits，直接返回
  if (oldProj.commits && oldProj.head && oldProj.version === "2.0") {
    return oldProj as QijiProject;
  }

  // 检查版本号并执行对应迁移
  const version = oldProj.version || "1.x";

  // v1.x -> v2.0
  if (version.startsWith("1") || !oldProj.commits) {
    const migrated = migrations["1.x-to-2.0"](oldProj);
    return migrated;
  }

  // 未知版本，尝试作为 v2.0 处理
  return {
    version: Qiji_VERSION,
    name: oldProj.name || "未命名项目",
    savedAt: oldProj.savedAt || new Date().toISOString(),
    head: oldProj.head || "commit-init",
    commits: oldProj.commits || {},
    files: oldProj.files || {},
    migrationLog: oldProj.migrationLog || [],
  };
}

/**
 * 记录迁移日志
 */
export function addMigrationLog(
  project: QijiProject,
  fromVersion: string,
  toVersion: string,
  description: string,
): QijiProject {
  const log: MigrationLogEntry = {
    fromVersion,
    toVersion,
    migratedAt: new Date().toISOString(),
    description,
  };

  return {
    ...project,
    migrationLog: [...(project.migrationLog || []), log],
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