/**
 * commitStore — 提交历史管理（类似 Git 的分支与快照模型）
 */
import { create } from "zustand";
import { useCanvasStore } from "./canvasStore";
import { useLibraryStore } from "./libraryStore";
import type { CommitSnapshot } from "@/services/projectFile";

const INITIAL_COMMIT: CommitSnapshot = {
  commitId: "commit-init",
  parentIds: [],
  message: "初始化项目",
  author: "System",
  timestamp: new Date().toISOString(),
  canvas: { nodes: {}, edges: {}, groups: {}, viewport: { x: 0, y: 0, zoom: 0.7 } },
  assets: {},
};

export function createInitialCommits(): Record<string, CommitSnapshot> {
  return {
    "commit-init": {
      ...INITIAL_COMMIT,
      timestamp: new Date().toISOString(),
    },
  };
}

export interface CreateCommitOptions {
  automatic?: boolean;
  /** 保存开始时捕获的结构，避免等待诊断/哈希时读取到之后的编辑。 */
  canvas?: CommitSnapshot["canvas"];
  assets?: NonNullable<CommitSnapshot["assets"]>;
  /** 保存所属的项目实例仍然有效。 */
  isCurrent?: () => boolean;
}

interface CommitState {
  head: string;
  commits: Record<string, CommitSnapshot>;

  setHead: (commitId: string) => void;
  setCommits: (commits: Record<string, CommitSnapshot>) => void;

  /** 创建新提交，返回 commitId；无变更时返回当前 head */
  createCommit: (message: string, options?: CreateCommitOptions) => Promise<string>;

  /** 检出指定提交，恢复画布与资产库 */
  checkoutCommit: (commitId: string) => void;
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/** 快照随历史裁剪/切项目回收；相同 ID 的旧项目不会复用另一个项目的哈希。 */
const commitHashCache = new WeakMap<CommitSnapshot, string>();

function contentJson(canvas: CommitSnapshot["canvas"], assets: CommitSnapshot["assets"]): string {
  // 视口另随项目画布保存，平移/缩放不产生内容版本。
  return JSON.stringify({ nodes: canvas.nodes, edges: canvas.edges, groups: canvas.groups, assets });
}

/** 历史版本上限；自动保存的当前恢复点另在创建时替换。 */
const MAX_COMMITS = 30;

export const useCommitStore = create<CommitState>((set, get) => ({
  head: "commit-init",
  commits: createInitialCommits(),

  setHead: (commitId) => set({ head: commitId }),

  setCommits: (commits) => set({ commits }),

  createCommit: async (message, options = {}) => {
    const s = get();
    const canvas = options.canvas ?? useCanvasStore.getState();
    const assets = options.assets ?? useLibraryStore.getState().assets;
    const currentCommitId = s.head;
    const currentCommit = s.commits[currentCommitId];
    const isCurrent = () => get().commits === s.commits && get().head === s.head
      && (options.isCurrent?.() ?? true);
    if (!isCurrent()) return currentCommitId;

    const finishUnchanged = () => {
      if (!options.automatic && currentCommit?.automatic) {
        // 手动保存把当前恢复点固定为历史版本，后续自动保存从它继续。
        const pinned: CommitSnapshot = { ...currentCommit, automatic: false, message, timestamp: new Date().toISOString() };
        const hash = commitHashCache.get(currentCommit);
        if (hash) commitHashCache.set(pinned, hash);
        set({ commits: { ...s.commits, [currentCommitId]: pinned } });
      }
      return currentCommitId;
    };

    if (currentCommit && currentCommit.canvas.nodes === canvas.nodes
      && currentCommit.canvas.edges === canvas.edges && currentCommit.canvas.groups === canvas.groups
      && currentCommit.assets === assets) {
      return finishUnchanged();
    }

    const contentHash = await sha256(contentJson(canvas, assets));
    if (!isCurrent()) return currentCommitId;
    if (currentCommit) {
      let currentHash = commitHashCache.get(currentCommit);
      if (!currentHash) {
        currentHash = await sha256(contentJson(currentCommit.canvas, currentCommit.assets));
        if (!isCurrent()) return currentCommitId;
        commitHashCache.set(currentCommit, currentHash);
      }
      if (currentHash === contentHash) return finishUnchanged();
    }

    // 相同内容可能已在其它手动分支中存在，不能按内容 ID 覆盖该历史版本。
    const baseId = `commit-${contentHash.slice(0, 12)}`;
    let commitId = baseId;
    for (let suffix = 1; s.commits[commitId]; suffix++) commitId = `${baseId}-${suffix}`;
    const replaceAutomatic = options.automatic && currentCommit?.automatic
      && !Object.values(s.commits).some((commit) => commit.commitId !== currentCommitId
        && commit.parentIds.includes(currentCommitId));
    const newCommit: CommitSnapshot = {
      commitId,
      automatic: options.automatic === true,
      parentIds: replaceAutomatic ? currentCommit.parentIds : [currentCommitId],
      message,
      author: "System",
      timestamp: new Date().toISOString(),
      canvas: {
        nodes: canvas.nodes,
        edges: canvas.edges,
        groups: canvas.groups,
        viewport: canvas.viewport,
      },
      assets,
    };
    commitHashCache.set(newCommit, contentHash);

    // 只替换明确标记的当前恢复点，不把旧版没有标记的历史当作自动保存。
    let commits: Record<string, CommitSnapshot> = { ...s.commits, [commitId]: newCommit };
    if (replaceAutomatic) delete commits[currentCommitId];
    // 原有最近历史上限，初始版本与新 head 也包含在 30 条内。
    // parentIds 仅作展示用途，指向被裁剪提交也无碍（checkout 只读 commit.canvas）。
    const all = Object.values(commits);
    if (all.length > MAX_COMMITS) {
      const keep = new Set([commitId]);
      if (commits["commit-init"]) keep.add("commit-init");
      for (const commit of all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())) {
        if (keep.size >= MAX_COMMITS) break;
        keep.add(commit.commitId);
      }
      commits = {};
      for (const commit of all) if (keep.has(commit.commitId)) commits[commit.commitId] = commit;
    }

    set({ head: commitId, commits });
    return commitId;
  },

  checkoutCommit: (commitId) => {
    const commit = get().commits[commitId];
    if (!commit) return;

    useCanvasStore.setState({
      nodes: commit.canvas.nodes,
      edges: commit.canvas.edges,
      groups: commit.canvas.groups,
      viewport: commit.canvas.viewport,
    });

    if (commit.assets) {
      useLibraryStore.setState({ assets: commit.assets });
    }

    set({ head: commitId });
  },
}));
