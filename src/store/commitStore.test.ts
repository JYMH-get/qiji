import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialCommits, useCommitStore } from "./commitStore";
import { useCanvasStore } from "./canvasStore";
import { useLibraryStore } from "./libraryStore";
import type { CommitSnapshot } from "@/services/projectFile";

function editCanvas(text: string) {
  useCanvasStore.setState({
    nodes: { n: { id: "n", type: "text", x: 0, y: 0, params: { text } } } as never,
  });
}

function head() {
  const state = useCommitStore.getState();
  return state.commits[state.head];
}

describe("提交历史与自动恢复点", () => {
  beforeEach(() => {
    useCommitStore.setState({ head: "commit-init", commits: createInitialCommits() });
    useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, viewport: { x: 0, y: 0, zoom: 1 } });
    useLibraryStore.setState({ assets: {} });
  });
  afterEach(() => vi.restoreAllMocks());

  it("平移缩放只保存当前视口，不新增或序列化历史快照", async () => {
    editCanvas("first");
    const id = await useCommitStore.getState().createCommit("自动保存", { automatic: true });
    useCanvasStore.setState({ viewport: { x: 200, y: 400, zoom: 0.3 } });
    const stringify = vi.spyOn(JSON, "stringify");
    expect(await useCommitStore.getState().createCommit("自动保存", { automatic: true })).toBe(id);
    expect(stringify).not.toHaveBeenCalled();
    expect(Object.keys(useCommitStore.getState().commits)).toHaveLength(2);
  });

  it("内容等价但引用重建时也忽略视口变化", async () => {
    editCanvas("first");
    const id = await useCommitStore.getState().createCommit("手动保存");
    editCanvas("first");
    useCanvasStore.setState({ viewport: { x: 1, y: 2, zoom: 2 } });
    expect(await useCommitStore.getState().createCommit("自动保存", { automatic: true })).toBe(id);
    expect(Object.keys(useCommitStore.getState().commits)).toHaveLength(2);
  });

  it("连续自动保存只保留一个最新恢复点，手动保存冻结后继续保留", async () => {
    for (let i = 0; i < 40; i++) {
      editCanvas(`result ${i}`);
      await useCommitStore.getState().createCommit("自动保存", { automatic: true });
    }
    expect(Object.keys(useCommitStore.getState().commits)).toHaveLength(2);
    const pinnedId = await useCommitStore.getState().createCommit("手动保存");
    expect(head().automatic).not.toBe(true);
    expect(head().message).toBe("手动保存");
    const pinned = head();
    for (let i = 40; i < 45; i++) {
      editCanvas(`result ${i}`);
      await useCommitStore.getState().createCommit("自动保存", { automatic: true });
    }
    expect(Object.keys(useCommitStore.getState().commits)).toHaveLength(3);
    expect(useCommitStore.getState().commits[pinnedId]).toBe(pinned);
    expect(head().parentIds).toEqual([pinnedId]);
  });

  it("旧版历史不被自动恢复点替换，重复内容不得覆盖已存在的手动版本", async () => {
    editCanvas("first");
    const firstId = await useCommitStore.getState().createCommit("first manual");
    const first = head();
    delete first.automatic; // 旧文件中没有该字段。
    editCanvas("second");
    await useCommitStore.getState().createCommit("自动保存", { automatic: true });
    editCanvas("first");
    const latestId = await useCommitStore.getState().createCommit("自动保存", { automatic: true });
    expect(latestId).not.toBe(firstId);
    expect(useCommitStore.getState().commits[firstId]).toBe(first);
    expect(first.message).toBe("first manual");
    expect(head().parentIds).toEqual([firstId]);
  });

  it("被保留分支引用的自动恢复点不会被删除", async () => {
    editCanvas("first");
    const automaticId = await useCommitStore.getState().createCommit("自动保存", { automatic: true });
    const automatic = head();
    editCanvas("branch");
    await useCommitStore.getState().createCommit("manual branch");
    useCommitStore.getState().checkoutCommit(automaticId);
    editCanvas("next automatic");
    await useCommitStore.getState().createCommit("自动保存", { automatic: true });
    expect(useCommitStore.getState().commits[automaticId]).toBe(automatic);
    expect(head().parentIds).toEqual([automaticId]);
  });

  it("快照和资产使用保存开始时捕获的数据", async () => {
    editCanvas("before");
    const canvas = useCanvasStore.getState();
    const assets = useLibraryStore.getState().assets;
    editCanvas("after");
    useLibraryStore.setState({ assets: { later: { id: "later" } } as never });
    await useCommitStore.getState().createCommit("自动保存", { automatic: true, canvas, assets });
    expect(head().canvas.nodes).toBe(canvas.nodes);
    expect(head().assets).toBe(assets);
  });

  it.each(["commits", "guard"])("异步计算期间切项目（%s）不能污染新项目", async (change) => {
    let release!: (value: ArrayBuffer) => void;
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    let current = true;
    editCanvas("old project");
    const pending = useCommitStore.getState().createCommit("自动保存", { automatic: true, isCurrent: () => current });
    let replacement: Record<string, CommitSnapshot> | undefined;
    if (change === "commits") {
      replacement = createInitialCommits();
      useCommitStore.setState({ head: "commit-init", commits: replacement });
    } else {
      current = false;
    }
    release(new ArrayBuffer(32));
    expect(await pending).toBe("commit-init");
    expect(Object.keys(useCommitStore.getState().commits)).toEqual(["commit-init"]);
    if (replacement) expect(useCommitStore.getState().commits).toBe(replacement);
  });

  it("历史数量上限包含初始版本，且保留最新手动版本", async () => {
    for (let i = 0; i < 40; i++) {
      editCanvas(`manual ${i}`);
      await useCommitStore.getState().createCommit(`manual ${i}`);
    }
    expect(Object.keys(useCommitStore.getState().commits)).toHaveLength(30);
    expect(useCommitStore.getState().commits["commit-init"]).toBeDefined();
    expect(head().message).toBe("manual 39");
  });

  // 显式运行的合成基准，避免普通回归套件反复分配约 100MB 的旧格式 JSON。
  if (process.env.QIJI_COMMIT_BENCHMARK === "1") {
    it("合成千节点自动保存体积与序列化基准", async () => {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const prompt = "画面人物动作环境镜头".repeat(112).slice(0, 1000);
      const nodes = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
        `node-${index}`, {
          id: `node-${index}`, type: "video", x: index * 10, y: index * 5,
          params: { prompt, resultHistory: Array.from({ length: 10 }, (_value, history) => `video-${index}-${history}`) },
        },
      ]));
      useCanvasStore.setState({ nodes: nodes as never });
      await useCommitStore.getState().createCommit("自动保存", { automatic: true });

      const viewportStart = performance.now();
      for (let index = 0; index < 30; index++) {
        useCanvasStore.setState({ viewport: { x: index * 20, y: index * 10, zoom: 0.5 + index / 100 } });
        await useCommitStore.getState().createCommit("自动保存", { automatic: true });
      }
      const viewportMs = performance.now() - viewportStart;
      const viewportCommitCount = Object.keys(useCommitStore.getState().commits).length;

      const editStart = performance.now();
      for (let index = 0; index < 30; index++) {
        const canvas = useCanvasStore.getState();
        const first = canvas.nodes["node-0"];
        useCanvasStore.setState({ nodes: { ...canvas.nodes, "node-0": { ...first, x: index + 1 } } });
        await useCommitStore.getState().createCommit("自动保存", { automatic: true });
      }
      const editMs = performance.now() - editStart;
      const canvas = useCanvasStore.getState();
      const currentCanvas = { nodes: canvas.nodes, edges: canvas.edges, groups: canvas.groups, viewport: canvas.viewport };
      const serialize = (commits: Record<string, CommitSnapshot>) => {
        const started = performance.now();
        const json = JSON.stringify({ canvas: currentCanvas, commits });
        const stringifyMs = performance.now() - started;
        return { commitCount: Object.keys(commits).length, jsonChars: json.length,
          utf8Bytes: Buffer.byteLength(json, "utf8"), stringifyMs };
      };
      const optimized = serialize(useCommitStore.getState().commits);
      const legacyCommits = createInitialCommits();
      for (let index = 0; index < 30; index++) {
        const commitId = `legacy-${index}`;
        legacyCommits[commitId] = { ...head(), commitId, automatic: undefined,
          parentIds: [index ? `legacy-${index - 1}` : "commit-init"],
          canvas: { ...currentCanvas, viewport: { x: index * 20, y: index * 10, zoom: 0.5 + index / 100 } } };
      }
      const legacy = serialize(legacyCommits);
      const report = {
        generatedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform },
        evidence: "合成数据，仅验证提交历史与JSON序列化；不是用户设备、WebView2、原生写盘或崩溃复现。",
        scenario: { nodes: 1000, chinesePromptCharsPerNode: 1000, historyReferencesPerNode: 10,
          viewportChanges: 30, nodeEdits: 30, serializedShape: "一份当前画布 + commits（不包含项目其余字段）" },
        viewport: { totalCreateCommitMs: viewportMs, commitCount: viewportCommitCount },
        nodeEditing: { totalCreateCommitMs: editMs, meanCreateCommitMs: editMs / 30 },
        optimized, legacy30FullSnapshots: legacy, utf8ReductionPercent: (1 - optimized.utf8Bytes / legacy.utf8Bytes) * 100,
      };
      mkdirSync("outputs/client-diagnostics-20261003", { recursive: true });
      writeFileSync("outputs/client-diagnostics-20261003/commit-benchmark.json", `${JSON.stringify(report, null, 2)}\n`);
      expect(viewportCommitCount).toBe(2);
      expect(optimized.commitCount).toBe(2);
      expect(optimized.utf8Bytes).toBeLessThan(legacy.utf8Bytes / 10);
    });
  }
});
