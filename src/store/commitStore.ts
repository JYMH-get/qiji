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
      const currentContent = JSON.stringify({
        nodes: currentCommit.canvas.nodes,
        edges: currentCommit.canvas.edges,
        groups: currentCommit.canvas.groups,
        viewport: currentCommit.canvas.viewport,
        assets: currentCommit.assets,
      });
      const currentHash = await sha256(currentContent);
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

      set({
        head: commitId,
        commits: { ...s.commits, [commitId]: newCommit },
      });
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