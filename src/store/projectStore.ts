/**
 * projectStore.ts — 项目元数据与文件 I/O 状态
 * 提交历史管理已拆分至 commitStore
 */
import { create } from "zustand";
import { useCanvasStore } from "./canvasStore";
import { useLibraryStore } from "./libraryStore";
import { useCommitStore, createInitialCommits } from "./commitStore";
import type { QijiProject } from "@/services/projectFile";
import { useSettingsStore } from "./settingsStore";
import { initDebouncedSave, scheduleSave } from "./debouncedSave";

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function getNewProjectPath(projectName: string): Promise<{ folderPath: string; filePath: string }> {
  const settings = useSettingsStore.getState();
  const userDataDir = await settings.getActiveUserDataDir();
  const { join } = await import("@tauri-apps/api/path");

  const now = new Date();
  const timestamp = now.getFullYear() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    "_" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");

  const cleanName = projectName.replace(/[\\/:*?"<>|]/g, "_");
  const folderName = `${cleanName}_${timestamp}`;

  const folderPath = await join(userDataDir, "projects", folderName);
  const filePath = await join(folderPath, "project.Qiji");
  return { folderPath, filePath };
}

async function normalizeProjectAssets(project: QijiProject, assetsDir: string) {
  if (!isTauri()) return;

  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const cleanAssetsDir = assetsDir.replace(/\\/g, "/");

  if (project.files) {
    for (const key of Object.keys(project.files)) {
      const oldPath = project.files[key];
      if (oldPath) {
        const filename = oldPath.split(/[/\\]/).pop() || "";
        project.files[key] = `${cleanAssetsDir}/${filename}`;
      }
    }
  }

  if (project.commits) {
    for (const commitId of Object.keys(project.commits)) {
      const commit = project.commits[commitId];
      if (commit.assets) {
        for (const assetId of Object.keys(commit.assets)) {
          const asset = commit.assets[assetId];
          if (asset && asset.localPath) {
            const filename = asset.localPath.split(/[/\\]/).pop() || "";
            const newPath = `${cleanAssetsDir}/${filename}`;
            asset.localPath = newPath;
            asset.uri = convertFileSrc(newPath);
          }
        }
      }
    }
  }
}

const RECENT_KEY = "Qiji:recentProjects";
const MAX_RECENT = 10;

export interface RecentProject {
  path: string;
  name: string;
  openedAt: string;
}

interface ProjectState {
  name: string;
  savePath: string | null;
  isDirty: boolean;
  recentProjects: RecentProject[];
  isSaving: boolean;
  fileRefs: Record<string, string | null>;
  isProjectLoading: boolean;
  scriptText: string;
  visualStyle: string;
  characters: Array<{ id: string; name: string; features: string; philosophy: string; prompt: string; image?: string }>;
  scenes: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string }>;
  items: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string }>;
  organisms: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string }>;
  isAnalyzed: boolean;
  analysisTime: string;
  projectModelConfig: {
    tableText?: string;
    tableImage?: string;
    tableVideo?: string;
    tableAudio?: string;
    canvasText?: string;
    canvasImage?: string;
    canvasVideo?: string;
    canvasAudio?: string;
  };

  setName: (name: string) => void;
  setSavePath: (path: string) => void;
  markDirty: () => void;
  markClean: () => void;
  addFileRef: (fileId: string, localPath: string | null) => void;
  removeFileRef: (fileId: string) => void;
  setScriptText: (text: string) => void;
  setVisualStyle: (style: string) => void;
  setAnalysisResult: (data: { characters: any[], scenes: any[], items: any[], organisms: any[], time: string }) => void;
  updateCharacterImage: (charId: string, imageUri: string) => void;
  setProjectModelConfig: (config: Partial<{
    tableText?: string;
    tableImage?: string;
    tableVideo?: string;
    tableAudio?: string;
    canvasText?: string;
    canvasImage?: string;
    canvasVideo?: string;
    canvasAudio?: string;
  }>) => void;

  save: (isManual?: boolean) => Promise<void>;
  scheduleAutoSave: (tier?: "canvas" | "history" | "viewport") => void;
  saveAs: () => Promise<void>;
  newProject: () => void;
  open: () => Promise<void>;
  loadFromPath: (path: string) => Promise<boolean>;
  exportProject: () => Promise<void>;
  importProject: () => Promise<void>;
  ensureProjectPath: () => Promise<string>;
}

function loadRecent(): RecentProject[] {
  try {
    const stored = localStorage.getItem(RECENT_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return [];
}

function saveRecent(projects: RecentProject[]) {
  localStorage.setItem(RECENT_KEY, JSON.stringify(projects));
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  name: "未命名项目",
  savePath: null,
  isDirty: false,
  recentProjects: loadRecent(),
  isSaving: false,
  isProjectLoading: false,
  fileRefs: {},
  scriptText: "",
  visualStyle: "国漫电影感",
  characters: [],
  scenes: [],
  items: [],
  organisms: [],
  isAnalyzed: false,
  analysisTime: "",
  projectModelConfig: {},

  setName: (name) => set({ name }),
  setSavePath: (path) => set({ savePath: path }),
  markDirty: () => set({ isDirty: true }),
  markClean: () => set({ isDirty: false }),
  addFileRef: (fileId, localPath) =>
    set((s) => ({ fileRefs: { ...s.fileRefs, [fileId]: localPath } })),
  removeFileRef: (fileId) =>
    set((s) => {
      const next = { ...s.fileRefs };
      delete next[fileId];
      return { fileRefs: next };
    }),
  setScriptText: (scriptText) => { set({ scriptText, isDirty: true }); get().scheduleAutoSave("canvas"); },
  setVisualStyle: (visualStyle) => { set({ visualStyle, isDirty: true }); get().scheduleAutoSave("canvas"); },
  setAnalysisResult: (data) => {
    set({
      characters: data.characters,
      scenes: data.scenes,
      items: data.items,
      organisms: data.organisms,
      isAnalyzed: true,
      analysisTime: data.time,
      isDirty: true,
    });
    get().scheduleAutoSave("canvas");
  },
  updateCharacterImage: (charId, imageUri) => {
    set((s) => ({
      characters: s.characters.map((c) => c.id === charId ? { ...c, image: imageUri } : c),
      isDirty: true,
    }));
    get().scheduleAutoSave("canvas");
  },
  setProjectModelConfig: (config) => {
    set((s) => ({
      projectModelConfig: { ...s.projectModelConfig, ...config },
      isDirty: true,
    }));
    get().scheduleAutoSave("canvas");
  },

  save: async (isManual = false) => {
    const s = get();
    if (s.isSaving) return;
    set({ isSaving: true });
    try {
      const canvas = useCanvasStore.getState();
      const message = isManual ? "手动保存" : "自动保存";
      const targetCommitId = await useCommitStore.getState().createCommit(message);
      const commits = useCommitStore.getState().commits;

      if (isTauri()) {
        const { writeTextFile, exists, mkdir } = await import("@tauri-apps/plugin-fs");
        const { join } = await import("@tauri-apps/api/path");

        let savePath = s.savePath;
        if (!savePath) {
          const { folderPath, filePath } = await getNewProjectPath(s.name);
          if (!(await exists(folderPath))) {
            await mkdir(folderPath, { recursive: true });
          }
          savePath = filePath;
          set({ savePath });
        }

        const folder = savePath.replace(/[/\\][^/\\]+$/, "");
        const assetsDir = await join(folder, "assets");
        if (!(await exists(assetsDir))) {
          await mkdir(assetsDir, { recursive: true });
        }

        const projectData: QijiProject = {
          version: "2.0",
          savedAt: new Date().toISOString(),
          name: s.name,
          nodes: canvas.nodes,
          edges: canvas.edges,
          groups: canvas.groups,
          viewport: canvas.viewport,
          files: s.fileRefs,
          commits,
          head: targetCommitId,
          scriptText: s.scriptText,
          visualStyle: s.visualStyle,
          characters: s.characters,
          scenes: s.scenes,
          items: s.items,
          organisms: s.organisms,
          isAnalyzed: s.isAnalyzed,
          analysisTime: s.analysisTime,
          projectModelConfig: s.projectModelConfig,
        };

        await normalizeProjectAssets(projectData, assetsDir);
        await writeTextFile(savePath, JSON.stringify(projectData, null, 2));

        // WebDAV 云端同步（异步，不阻塞本地保存）
        maybeSyncToWebdav(projectData);

        const recent = get().recentProjects;
        const existing = recent.findIndex((p) => p.path === savePath);
        const entry = { path: savePath, name: s.name, openedAt: new Date().toISOString() };
        const updated = existing >= 0
          ? [entry, ...recent.filter((_, i) => i !== existing)]
          : [entry, ...recent];
        saveRecent(updated.slice(0, MAX_RECENT));
        set({ recentProjects: updated.slice(0, MAX_RECENT), isDirty: false });
        useSettingsStore.getState().setLastOpenedProjectPath(savePath);
      } else {
        const projectData: QijiProject = {
          version: "2.0",
          savedAt: new Date().toISOString(),
          name: s.name,
          nodes: canvas.nodes,
          edges: canvas.edges,
          groups: canvas.groups,
          viewport: canvas.viewport,
          files: s.fileRefs,
          commits,
          head: targetCommitId,
          scriptText: s.scriptText,
          visualStyle: s.visualStyle,
          characters: s.characters,
          scenes: s.scenes,
          items: s.items,
          organisms: s.organisms,
          isAnalyzed: s.isAnalyzed,
          analysisTime: s.analysisTime,
          projectModelConfig: s.projectModelConfig,
        };
        const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${s.name.replace(/[\\/:*?"<>|]/g, "_")}.Qiji`;
        a.click();
        URL.revokeObjectURL(url);
        set({ isDirty: false });
      }
    } catch (err) {
      console.error("Failed to save project:", err);
    } finally {
      set({ isSaving: false });
    }
  },

  saveAs: async () => {
    if (isTauri()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        filters: [{ name: "Qiji Project", extensions: ["Qiji"] }],
      });
      if (path) {
        set({ savePath: path as string });
        await get().save(true);
      }
    } else {
      await get().save(true);
    }
  },

  newProject: () => {
    set({
      name: "未命名项目",
      savePath: null,
      isDirty: false,
      fileRefs: {},
      scriptText: "",
      visualStyle: "国漫电影感",
      characters: [],
      scenes: [],
      items: [],
      organisms: [],
      isAnalyzed: false,
      analysisTime: "",
      projectModelConfig: {},
    });
    useCommitStore.setState({ head: "commit-init", commits: createInitialCommits() });
    useCanvasStore.setState({
      nodes: {},
      edges: {},
      groups: {},
      viewport: { x: 0, y: 0, zoom: 0.7 },
    });
    useLibraryStore.setState({ assets: {} });
  },

  open: async () => {
    if (isTauri()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        filters: [{ name: "Qiji Project", extensions: ["Qiji"] }],
      });
      if (path) {
        await get().loadFromPath(path as string);
      }
    }
  },

  loadFromPath: async (path: string): Promise<boolean> => {
    set({ isProjectLoading: true });
    try {
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const content = await readTextFile(path);
      const project: QijiProject = JSON.parse(content);

      const headId = project.head || "commit-init";
      const headCommit = project.commits?.[headId];

      const nodes = project.nodes && Object.keys(project.nodes).length > 0
        ? project.nodes
        : headCommit?.canvas?.nodes || {};
      const edges = project.edges && Object.keys(project.edges).length > 0
        ? project.edges
        : headCommit?.canvas?.edges || {};
      const groups = project.groups && Object.keys(project.groups).length > 0
        ? project.groups
        : headCommit?.canvas?.groups || {};
      const viewport = project.viewport || headCommit?.canvas?.viewport || { x: 0, y: 0, zoom: 0.7 };

      set({
        name: project.name || "未命名项目",
        savePath: path,
        fileRefs: project.files || {},
        isDirty: false,
        scriptText: project.scriptText || "",
        visualStyle: project.visualStyle || "国漫电影感",
        characters: project.characters || [],
        scenes: project.scenes || [],
        items: project.items || [],
        organisms: project.organisms || [],
        isAnalyzed: project.isAnalyzed || false,
        analysisTime: project.analysisTime || "",
        projectModelConfig: project.projectModelConfig || {},
      });

      useCommitStore.setState({
        head: headId,
        commits: project.commits || {},
      });

      useCanvasStore.setState({ nodes, edges, groups, viewport });

      if (headCommit?.assets && Object.keys(headCommit.assets).length > 0) {
        useLibraryStore.setState({ assets: headCommit.assets });
      } else if ((project as any).assets) {
        useLibraryStore.setState({ assets: (project as any).assets });
      }

      useSettingsStore.getState().setLastOpenedProjectPath(path);

      const recent = get().recentProjects;
      const existing = recent.findIndex((p) => p.path === path);
      const entry = { path, name: project.name || "未命名项目", openedAt: new Date().toISOString() };
      const updated = existing >= 0
        ? [entry, ...recent.filter((_, i) => i !== existing)]
        : [entry, ...recent];
      saveRecent(updated.slice(0, MAX_RECENT));
      set({ recentProjects: updated.slice(0, MAX_RECENT) });

      return true;
    } catch (err) {
      console.error("Failed to load project:", err);
      return false;
    } finally {
      set({ isProjectLoading: false });
    }
  },

  exportProject: async () => {
    const canvas = useCanvasStore.getState();
    const s = get();
    const { head, commits } = useCommitStore.getState();

    const projectData: QijiProject = {
      version: "2.0",
      savedAt: new Date().toISOString(),
      name: s.name,
      nodes: canvas.nodes,
      edges: canvas.edges,
      groups: canvas.groups,
      viewport: canvas.viewport,
      files: s.fileRefs,
      commits,
      head,
      scriptText: s.scriptText,
      visualStyle: s.visualStyle,
      characters: s.characters,
      scenes: s.scenes,
      items: s.items,
      organisms: s.organisms,
      isAnalyzed: s.isAnalyzed,
      analysisTime: s.analysisTime,
      projectModelConfig: s.projectModelConfig,
    };

    const blob = new Blob([JSON.stringify(projectData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.name.replace(/[\\/:*?"<>|]/g, "_")}_export.Qiji`;
    a.click();
    URL.revokeObjectURL(url);
  },

  importProject: async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".Qiji,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const project: QijiProject = JSON.parse(e.target?.result as string);
          set({
            name: project.name || "导入项目",
            savePath: null,
            fileRefs: project.files || {},
            isDirty: true,
            scriptText: project.scriptText || "",
            visualStyle: project.visualStyle || "国漫电影感",
            characters: project.characters || [],
            scenes: project.scenes || [],
            items: project.items || [],
            organisms: project.organisms || [],
            isAnalyzed: project.isAnalyzed || false,
            analysisTime: project.analysisTime || "",
            projectModelConfig: project.projectModelConfig || {},
          });
          useCommitStore.setState({
            head: project.head || "commit-init",
            commits: project.commits || {},
          });
          useCanvasStore.setState({
            nodes: (project as any).nodes || {},
            edges: (project as any).edges || {},
            groups: (project as any).groups || {},
            viewport: (project as any).viewport || { x: 0, y: 0, zoom: 0.7 },
          });
          if ((project as any).assets) {
            useLibraryStore.setState({ assets: (project as any).assets });
          }
        } catch (err) {
          console.error("Failed to import project:", err);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  },

  ensureProjectPath: async (): Promise<string> => {
    if (!isTauri()) return "browser";
    const s = get();
    if (s.savePath) return s.savePath;
    const { folderPath, filePath } = await getNewProjectPath(s.name);
    const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
    if (!(await exists(folderPath))) {
      await mkdir(folderPath, { recursive: true });
    }
    set({ savePath: filePath });
    return filePath;
  },

  scheduleAutoSave: (tier = "canvas") => {
    scheduleSave(tier);
  },
}));

// 初始化三档去抖：绑定 save / markDirty
initDebouncedSave(
  () => useProjectStore.getState().save(),
  () => useProjectStore.getState().markDirty(),
);

// ─── WebDAV 云端同步（fire-and-forget，不阻塞本地保存） ───

let _lastSyncTimer: ReturnType<typeof setTimeout> | null = null;

function maybeSyncToWebdav(projectData: QijiProject) {
  const settings = useSettingsStore.getState();
  if (!settings.enableCloudSync || !settings.webdavUrl.trim()) return;

  // 去抖 2s：短时间内多次保存只触发最后一次同步
  if (_lastSyncTimer) clearTimeout(_lastSyncTimer);
  _lastSyncTimer = setTimeout(async () => {
    try {
      const { uploadProjectFile } = await import("@/services/webdavSync");
      const config = {
        url: settings.webdavUrl,
        directory: settings.webdavDirectory,
        username: settings.webdavUsername,
        password: settings.webdavPassword,
      };
      const projectName = (projectData.name || "untitled").replace(/[\\/:*?"<>|]/g, "_");
      const projectFileName = `${projectName}.Qiji`;
      await uploadProjectFile(config, projectFileName, JSON.stringify(projectData, null, 2));
      console.log(`[WebDAV] 项目 "${projectName}" 已同步`);
    } catch (err) {
      console.error("[WebDAV] 同步失败:", err);
    }
  }, 2000);
}