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

interface CommitState {
  head: string;
  commits: Record<string, CommitSnapshot>;

  setHead: (commitId: string) => void;
  setCommits: (commits: Record<string, CommitSnapshot>) => void;

  /** 创建新提交，返回 commitId；无变更时返回当前 head */
  createCommit: (message: string) => Promise<string>;

  /** 检出指定提交，恢复画布与资产库 */
  checkoutCommit: (commitId: string) => void;
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/** commitId → 内容哈希缓存：免去每次自动保存都把"当前 head 提交"再整个 stringify+哈希一遍 */
const commitHashCache = new Map<string, string>();

/** 提交链上限：自动保存每次变更都会追加全量画布快照，不设上限项目文件会无限膨胀、保存越来越慢 */
const MAX_COMMITS = 30;

export const useCommitStore = create<CommitState>((set, get) => ({
  head: "commit-init",
  commits: createInitialCommits(),

  setHead: (commitId) => set({ head: commitId }),

  setCommits: (commits) => set({ commits }),

  createCommit: async (message) => {
    const s = get();
    const canvas = useCanvasStore.getState();
    const assets = useLibraryStore.getState().assets;

    const commitContent = JSON.stringify({
      nodes: canvas.nodes,
      edges: canvas.edges,
      groups: canvas.groups,
      viewport: canvas.viewport,
      assets,
    });
    const contentHash = await sha256(commitContent);
    const commitId = `commit-${contentHash.slice(0, 12)}`;

    const currentCommitId = s.head;
    const currentCommit = s.commits[currentCommitId];

    let hasChanges = true;
    if (currentCommit) {
      // 优先用缓存的哈希：免去把当前 head 提交再整个 stringify+哈希（自动保存高频路径）
      let currentHash = commitHashCache.get(currentCommitId);
      if (!currentHash) {
        const currentContent = JSON.stringify({
          nodes: currentCommit.canvas.nodes,
          edges: currentCommit.canvas.edges,
          groups: currentCommit.canvas.groups,
          viewport: currentCommit.canvas.viewport,
          assets: currentCommit.assets,
        });
        currentHash = await sha256(currentContent);
        commitHashCache.set(currentCommitId, currentHash);
      }
      if (currentHash === contentHash) {
        hasChanges = false;
      }
    }

    if (hasChanges) {
      const newCommit: CommitSnapshot = {
        commitId,
        parentIds: [currentCommitId],
        message,
        author: "System",
        timestamp: new Date().toISOString(),
        canvas: {
          nodes: canvas.nodes,
          edges: canvas.edges,
          groups: canvas.groups,
          viewport: canvas.viewport,
        },
        assets: { ...assets },
      };
      commitHashCache.set(commitId, contentHash);

      // 上限裁剪：只留最近 MAX_COMMITS 条（按时间倒序；恒保留新 head 与 commit-init）。
      // parentIds 仅作展示用途，指向被裁剪提交也无碍（checkout 只读 commit.canvas）。
      let commits: Record<string, CommitSnapshot> = { ...s.commits, [commitId]: newCommit };
      const all = Object.values(commits);
      if (all.length > MAX_COMMITS) {
        const keep = new Set(
          all
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
            .slice(0, MAX_COMMITS)
            .map((c) => c.commitId),
        );
        keep.add(commitId);
        keep.add("commit-init");
        commits = {};
        for (const c of all) if (keep.has(c.commitId)) commits[c.commitId] = c;
      }

      set({ head: commitId, commits });
      return commitId;
    }

    return currentCommitId;
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