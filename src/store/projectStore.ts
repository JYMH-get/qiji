/**
 * projectStore.ts — 项目元数据状态（支持类似 Git 的分支与历史快照）
 */
import { create } from "zustand";
import { useCanvasStore } from "./canvasStore";
import { useLibraryStore } from "./libraryStore";
import { saveProject, openProject, loadProjectFromPath, migrateProject } from "@/services/projectFile";
import type { QijiProject, CommitSnapshot } from "@/services/projectFile";
import { useSettingsStore } from "./settingsStore";

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
  const isTaur = isTauri();
  if (!isTaur) return;
  
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

  // Git-like 版本控制状态
  head: string; // 指向的具体 commitId
  commits: Record<string, CommitSnapshot>; // 提交历史快照

  setName: (name: string) => void;
  setSavePath: (path: string) => void;
  markDirty: () => void;
  markClean: () => void;
  addFileRef: (fileId: string, localPath: string | null) => void;
  removeFileRef: (fileId: string) => void;

  save: (isManual?: boolean) => Promise<void>;
  saveAs: () => Promise<void>;
  newProject: () => void;
  open: () => Promise<void>;
  loadFromPath: (path: string) => Promise<boolean>;
  exportProject: () => Promise<void>;
  importProject: () => Promise<void>;
  ensureProjectPath: () => Promise<string>;

  // 版本控制操作
  checkoutCommit: (commitId: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  name: "未命名项目",
  savePath: null,
  isDirty: false,
  recentProjects: loadRecent(),
  isSaving: false,
  isProjectLoading: false,
  fileRefs: {},

  // 初始 Git-like 状态
  head: "commit-init",
  commits: {
    "commit-init": {
      commitId: "commit-init",
      parentIds: [],
      message: "初始化项目",
      author: "System",
      timestamp: new Date().toISOString(),
      canvas: { nodes: {}, edges: {}, groups: {}, viewport: { x: 0, y: 0, zoom: 0.7 } },
      assets: {},
    }
  },

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

  save: async (isManual = false) => {
    const s = get();
    if (s.isSaving) return;
    set({ isSaving: true });
    try {
      const canvas = useCanvasStore.getState();
      const assets = useLibraryStore.getState().assets;

      // 序列化快照内容并计算 hash
      const commitContent = JSON.stringify({
        nodes: canvas.nodes,
        edges: canvas.edges,
        groups: canvas.groups,
        viewport: canvas.viewport,
        assets
      });
      const contentHash = await sha256(commitContent);
      const commitId = `commit-${contentHash.slice(0, 12)}`;

      const currentCommitId = s.head;
      let targetCommitId = currentCommitId;
      const nextCommits = { ...s.commits };

      const currentCommit = s.commits[currentCommitId];
      let hasChanges = true;
      if (currentCommit) {
        const isCanvasEqual = JSON.stringify(currentCommit.canvas) === JSON.stringify({
          nodes: canvas.nodes,
          edges: canvas.edges,
          groups: canvas.groups,
          viewport: canvas.viewport
        });
        const isAssetsEqual = JSON.stringify(currentCommit.assets) === JSON.stringify(assets);
        if (isCanvasEqual && isAssetsEqual) {
          hasChanges = false;
        }
      }

      if (hasChanges) {
        const newCommit: CommitSnapshot = {
          commitId,
          parentIds: currentCommitId ? [currentCommitId] : [],
          message: isManual ? "用户手动保存" : "自动保存",
          author: "LocalUser",
          timestamp: new Date().toISOString(),
          canvas: {
            nodes: canvas.nodes,
            edges: canvas.edges,
            groups: canvas.groups,
            viewport: canvas.viewport
          },
          assets
        };
        nextCommits[commitId] = newCommit;
        targetCommitId = commitId;
      }

      const targetPath = s.savePath;
      let targetName = s.name;
      if (targetPath) {
        const filename = targetPath.split(/[/\\]/).pop() || "";
        targetName = filename.replace(/\.Qiji$/i, "");
      }

      const projectData: QijiProject = {
        version: "2.0",
        name: targetName,
        savedAt: "",
        head: targetCommitId,
        commits: nextCommits,
        files: s.fileRefs
      };

      const path = await saveProject(projectData, targetPath);
      if (path) {
        const filename = path.split(/[/\\]/).pop() || "";
        const baseName = filename.replace(/\.Qiji$/i, "");
        set({
          savePath: path,
          name: baseName,
          isDirty: false,
          commits: nextCommits,
          head: targetCommitId
        });
        addToRecent(path, baseName);
        set({ recentProjects: loadRecent() });
        useSettingsStore.getState().setLastOpenedProjectPath(path);
      }
    } catch (err: any) {
      console.error("Failed to save project:", err);
      alert("保存项目失败:\n" + (err?.message || JSON.stringify(err)));
    } finally {
      set({ isSaving: false });
    }
  },

  saveAs: async () => {
    const s = get();
    set({ isSaving: true });
    try {
      const canvas = useCanvasStore.getState();
      const assets = useLibraryStore.getState().assets;

      const commitContent = JSON.stringify({
        nodes: canvas.nodes,
        edges: canvas.edges,
        groups: canvas.groups,
        viewport: canvas.viewport,
        assets
      });
      const contentHash = await sha256(commitContent);
      const commitId = `commit-${contentHash.slice(0, 12)}`;

      const currentCommitId = s.head;
      const nextCommits = { ...s.commits };

      if (!nextCommits[commitId]) {
        nextCommits[commitId] = {
          commitId,
          parentIds: currentCommitId ? [currentCommitId] : [],
          message: "另存为新项目",
          author: "LocalUser",
          timestamp: new Date().toISOString(),
          canvas: {
            nodes: canvas.nodes,
            edges: canvas.edges,
            groups: canvas.groups,
            viewport: canvas.viewport
          },
          assets
        };
      }

      const projectData: QijiProject = {
        version: "2.0",
        name: s.name,
        savedAt: "",
        head: commitId,
        commits: nextCommits,
        files: s.fileRefs
      };

      const path = await saveProject(projectData, null);
      if (path) {
        const filename = path.split(/[/\\]/).pop() || "";
        const baseName = filename.replace(/\.Qiji$/i, "");
        set({
          savePath: path,
          name: baseName,
          isDirty: false,
          commits: nextCommits,
          head: commitId
        });
        addToRecent(path, baseName);
        set({ recentProjects: loadRecent() });
        useSettingsStore.getState().setLastOpenedProjectPath(path);
      }
    } catch (err: any) {
      console.error("Failed to save project as:", err);
      alert("另存为项目失败:\n" + (err?.message || JSON.stringify(err)));
    } finally {
      set({ isSaving: false });
    }
  },

  newProject: () => {
    set({ isProjectLoading: true });
    
    const initialCommit: CommitSnapshot = {
      commitId: "commit-init",
      parentIds: [],
      message: "初始化项目",
      author: "System",
      timestamp: new Date().toISOString(),
      canvas: { nodes: {}, edges: {}, groups: {}, viewport: { x: 0, y: 0, zoom: 0.7 } },
      assets: {},
    };

    useCanvasStore.getState().setStructure(initialCommit.canvas);
    useLibraryStore.setState({ assets: {} });

    set({
      name: "未命名项目",
      savePath: null,
      isDirty: false,
      fileRefs: {},
      head: "commit-init",
      commits: { "commit-init": initialCommit },
      isProjectLoading: false,
    });
    useSettingsStore.getState().setLastOpenedProjectPath(null);
  },

  open: async () => {
    try {
      const result = await openProject();
      if (!result) return;
      
      const { project, path } = result;
      const isTaur = isTauri();
      
      let finalPath = path;
      if (isTaur) {
        const settings = useSettingsStore.getState();
        const userDataDir = await settings.getActiveUserDataDir();
        const { join } = await import("@tauri-apps/api/path");
        
        const normPath = path.replace(/\\/g, "/");
        const normUserDir = userDataDir.replace(/\\/g, "/");
        const isUnderUserData = normPath.startsWith(normUserDir);
        
        if (!isUnderUserData) {
          const { folderPath, filePath } = await getNewProjectPath(project.name);
          const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
          await mkdir(folderPath, { recursive: true });
          await mkdir(await join(folderPath, "assets"), { recursive: true });
          
          const assetsDir = await join(folderPath, "assets");
          await normalizeProjectAssets(project, assetsDir);
          
          const json = JSON.stringify(project, null, 2);
          const encoder = new TextEncoder();
          await writeFile(filePath, encoder.encode(json));
          finalPath = filePath;
        } else {
          const folder = path.replace(/[/\\][^/\\]+$/, "");
          const assetsDir = await join(folder, "assets");
          await normalizeProjectAssets(project, assetsDir);
        }
      }
      
      set({ isProjectLoading: true });
      applyProject(project);

      const filename = finalPath.split(/[/\\]/).pop() || "";
      const baseName = filename.replace(/\.Qiji$/i, "");

      const head = project.head;

      set({
        name: baseName,
        savePath: finalPath,
        isDirty: false,
        fileRefs: project.files ?? {},
        head,
        commits: project.commits,
        isProjectLoading: false,
      });
      addToRecent(finalPath, baseName);
      set({ recentProjects: loadRecent() });
      useSettingsStore.getState().setLastOpenedProjectPath(finalPath);
    } catch (err: any) {
      console.error("Failed to open project:", err);
      alert("打开项目失败:\n" + (err?.message || JSON.stringify(err)));
    }
  },

  loadFromPath: async (path: string) => {
    const project = await loadProjectFromPath(path);
    if (!project) return false;
    set({ isProjectLoading: true });
    
    const isTaur = isTauri();
    if (isTaur) {
      const folder = path.replace(/[/\\][^/\\]+$/, "");
      const { join } = await import("@tauri-apps/api/path");
      const assetsDir = await join(folder, "assets");
      await normalizeProjectAssets(project, assetsDir);
    }
    
    applyProject(project);

    const filename = path.split(/[/\\]/).pop() || "";
    const baseName = filename.replace(/\.Qiji$/i, "");

    const head = project.head;

    set({
      name: baseName,
      savePath: path,
      isDirty: false,
      fileRefs: project.files ?? {},
      head,
      commits: project.commits,
      isProjectLoading: false,
    });
    useSettingsStore.getState().setLastOpenedProjectPath(path);
    return true;
  },

  exportProject: async () => {
    const s = get();
    if (!s.savePath) {
      alert("请先保存项目再导出！");
      return;
    }
    const isTaur = isTauri();
    if (!isTaur) {
      alert("浏览器环境下暂不支持导出！");
      return;
    }
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { readFile, writeFile, exists, readDir } = await import("@tauri-apps/plugin-fs");
      const { join } = await import("@tauri-apps/api/path");
      const JSZip = (await import("jszip")).default;

      const defaultPath = s.savePath.replace(/\.Qiji$/i, ".zip");
      const zipPath = await save({
        defaultPath,
        filters: [{ name: "Qiji ZIP 存档", extensions: ["zip"] }],
      }) as string | null;

      if (!zipPath) return;

      set({ isSaving: true });

      const zip = new JSZip();
      const projectBytes = await readFile(s.savePath);
      zip.file("project.Qiji", projectBytes);

      const folder = s.savePath.replace(/[/\\][^/\\]+$/, "");
      const assetsDir = await join(folder, "assets");
      
      if (await exists(assetsDir)) {
        const entries = await readDir(assetsDir);
        for (const entry of entries) {
          if (entry.isFile) {
            const filePath = await join(assetsDir, entry.name);
            const fileBytes = await readFile(filePath);
            zip.file(`assets/${entry.name}`, fileBytes);
          }
        }
      }

      const zipContent = await zip.generateAsync({ type: "uint8array" });
      await writeFile(zipPath, zipContent);
      alert("导出项目成功！");
    } catch (err: any) {
      console.error("Failed to export project:", err);
      alert("导出项目失败:\n" + (err?.message || JSON.stringify(err)));
    } finally {
      set({ isSaving: false });
    }
  },

  importProject: async () => {
    const isTaur = isTauri();
    if (!isTaur) {
      alert("浏览器环境下暂不支持导入！");
      return;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readFile, writeFile, mkdir } = await import("@tauri-apps/plugin-fs");
      const { join } = await import("@tauri-apps/api/path");
      const JSZip = (await import("jszip")).default;

      const selected = await open({
        multiple: false,
        filters: [{ name: "Qiji ZIP 存档", extensions: ["zip"] }],
      }) as string | null;

      if (!selected) return;

      set({ isProjectLoading: true });

      const zipData = await readFile(selected);
      const zip = await JSZip.loadAsync(zipData);

      const qijiFile = zip.file("project.Qiji");
      if (!qijiFile) {
        throw new Error("ZIP 文件中未找到 project.Qiji，无效的 Qiji 项目存档！");
      }

      const qijiJson = await qijiFile.async("string");
      const project = JSON.parse(qijiJson) as QijiProject;
      const migrated = migrateProject(project);

      const { folderPath, filePath } = await getNewProjectPath(migrated.name);
      await mkdir(folderPath, { recursive: true });
      
      const assetsDir = await join(folderPath, "assets");
      await mkdir(assetsDir, { recursive: true });

      const zipAssets = zip.folder("assets");
      if (zipAssets) {
        const fileNames: string[] = [];
        zipAssets.forEach((relativePath, file) => {
          if (!file.dir) {
            fileNames.push(relativePath);
          }
        });

        for (const fileName of fileNames) {
          const zipFile = zipAssets.file(fileName);
          if (zipFile) {
            const fileBytes = await zipFile.async("uint8array");
            const destPath = await join(assetsDir, fileName);
            await writeFile(destPath, fileBytes);
          }
        }
      }

      await normalizeProjectAssets(migrated, assetsDir);

      const updatedJson = JSON.stringify(migrated, null, 2);
      const encoder = new TextEncoder();
      await writeFile(filePath, encoder.encode(updatedJson));

      applyProject(migrated);

      const filename = filePath.split(/[/\\]/).pop() || "";
      const baseName = filename.replace(/\.Qiji$/i, "");

      const head = migrated.head;

      set({
        name: baseName,
        savePath: filePath,
        isDirty: false,
        fileRefs: migrated.files ?? {},
        head,
        commits: migrated.commits,
        isProjectLoading: false,
      });

      addToRecent(filePath, baseName);
      set({ recentProjects: loadRecent() });
      useSettingsStore.getState().setLastOpenedProjectPath(filePath);

      alert("导入项目成功！");
    } catch (err: any) {
      console.error("Failed to import project:", err);
      alert("导入项目失败:\n" + (err?.message || JSON.stringify(err)));
      set({ isProjectLoading: false });
    }
  },

  ensureProjectPath: async () => {
    const s = get();
    if (s.savePath) {
      const { mkdir, exists } = await import("@tauri-apps/plugin-fs");
      const { join } = await import("@tauri-apps/api/path");
      const folder = s.savePath.replace(/[/\\][^/\\]+$/, "");
      if (!(await exists(folder))) {
        await mkdir(folder, { recursive: true });
      }
      const assetsDir = await join(folder, "assets");
      if (!(await exists(assetsDir))) {
        await mkdir(assetsDir, { recursive: true });
      }
      return s.savePath;
    }
    
    const { folderPath, filePath } = await getNewProjectPath(s.name);
    const { mkdir } = await import("@tauri-apps/plugin-fs");
    const { join } = await import("@tauri-apps/api/path");
    await mkdir(folderPath, { recursive: true });
    await mkdir(await join(folderPath, "assets"), { recursive: true });
    
    set({ savePath: filePath });
    return filePath;
  },

  checkoutCommit: async (commitId: string) => {
    const s = get();
    const commit = s.commits[commitId];
    if (!commit) {
      alert("未找到该提交快照！");
      return;
    }

    set({ isProjectLoading: true });
    useCanvasStore.getState().setStructure(commit.canvas);
    useLibraryStore.setState({ assets: commit.assets ?? {} });
    set({
      head: commitId,
      isProjectLoading: false,
      isDirty: false,
    });

    await get().save();
  },
}));

async function sha256(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function applyProject(project: QijiProject) {
  const commitId = project.head;
  const commit = project.commits[commitId];
  if (commit) {
    useCanvasStore.getState().setStructure(commit.canvas);
    useLibraryStore.setState({ assets: commit.assets ?? {} });
  } else {
    const firstCommitId = Object.keys(project.commits)[0];
    const firstCommit = project.commits[firstCommitId];
    if (firstCommit) {
      useCanvasStore.getState().setStructure(firstCommit.canvas);
      useLibraryStore.setState({ assets: firstCommit.assets ?? {} });
    }
  }
}

function loadRecent(): RecentProject[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as RecentProject[];
  } catch {
    return [];
  }
}

function addToRecent(path: string, name: string) {
  const list = loadRecent().filter((r) => r.path !== path);
  list.unshift({ path, name, openedAt: new Date().toISOString() });
  if (list.length > MAX_RECENT) list.length = MAX_RECENT;
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

// 自动保存：canvasStore 变更后 debounce 1.5s 写盘
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
useCanvasStore.subscribe(() => {
  const ps = useProjectStore.getState();
  if (ps.isProjectLoading) return;
  ps.markDirty();
  if (!ps.savePath) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    useProjectStore.getState().save();
  }, 1500);
});

