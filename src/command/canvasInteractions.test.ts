import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, CanvasEdge } from "@/types";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(), project: { projectInstanceId: "test", canvasEpisodeId: "ep1", episodes: [{ id: "ep1" }, { id: "ep2" }] },
  deleteFile: vi.fn(), removeFileRef: vi.fn(),
}));
vi.mock("@/nodes/pluginRegistry", () => ({
  getPlugin: (type: string) => type === "unknown" ? undefined : ({
    execute: mocks.execute, nodeKind: type === "upload" ? "upload" : type === "text.seed" ? "seed" : "run",
  }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => ({ ...mocks.project, removeFileRef: mocks.removeFileRef }) },
  resolveEpisodeKey: (id: string, episodes: { id: string }[]) => episodes.find((e) => e.id === id)?.id || episodes[0]?.id || "",
}));
vi.mock("@/services/fileStorage", () => ({ deleteStoredFile: mocks.deleteFile }));

import { useCanvasStore } from "@/store/canvasStore";
import { useUiStore } from "@/store/uiStore";
import { dispatchCommand } from "./dispatch";
import { commandBus } from "./commandBus";
import { registerExecutionHandlers, registerHistoryHandlers } from "./handlers/executionHandlers";
import { registerDeleteHandlers } from "./handlers/deleteHandlers";
import { runSelectedNodes, useRunSelectionFeedback } from "@/canvas/runSelection";
import { isRunnableNode } from "./nodeRunEligibility";
import { getPlugin } from "@/nodes/pluginRegistry";

registerExecutionHandlers(); registerHistoryHandlers(); registerDeleteHandlers();
let instance = 0;
const node = (id: string, type = "image.gen", params = {}): CanvasNode => ({ id, type, x: 0, y: 0, w: 100, h: 100, parentId: null, parentScriptId: null, data: { input: {}, params, resultAssetId: null } });
const edge = (id: string, source: string, target: string): CanvasEdge => ({ id, source, target, sourcePort: "out", targetPort: "in", kind: "dataflow" });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
beforeEach(() => {
  mocks.project.projectInstanceId = `isolated-${++instance}`;
  mocks.project.canvasEpisodeId = "ep1";
  mocks.execute.mockReset().mockImplementation(() => new Promise(() => {}));
  mocks.deleteFile.mockReset(); mocks.removeFileRef.mockReset();
  useCanvasStore.setState({ nodes: { a: node("a"), b: node("b"), c: node("c"), d: node("d") }, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
  useUiStore.setState({ selectedNodeIds: [], selectedEdgeIds: [], activeNodeId: null });
  useRunSelectionFeedback.setState({ message: null, revision: 0 });
});
afterEach(() => vi.restoreAllMocks());

describe("central run reservation", () => {
  it("does not resubmit a persisted accepted task before runtime recovery", () => {
    const n = node("a"); n.data.task = { taskId: "accepted-task", adapterKey: "mock", startedAt: 1 };
    useCanvasStore.setState({ nodes: { a: n }, runtime: {} });
    expect(dispatchCommand({ type: "run", nodeId: "a" })).toEqual({ started: false, reason: "recovering" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().runtime.a).toBeUndefined();
  });
  it("permits retry after a failed/lost poll while preserving the task for plugin recovery", () => {
    const n = node("a"); n.data.task = { taskId: "accepted-task", adapterKey: "mock", startedAt: 1 };
    useCanvasStore.setState({ nodes: { a: n } });
    useCanvasStore.getState().setRuntime("a", { status: "failed", error: "connection lost" });
    expect(dispatchCommand({ type: "run", nodeId: "a" })?.started).toBe(true);
    expect(useCanvasStore.getState().nodes.a.data.task).toEqual(n.data.task);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["queued", "running"] as const)("skips an already %s node without calling execute", (status) => {
    useCanvasStore.getState().setRuntime("a", { status, progress: 45 });
    expect(dispatchCommand({ type: "run", nodeId: "a" })).toEqual({ started: false, reason: "busy" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().runtime.a.progress).toBe(45);
  });
  it("serializes GUI, copilot and agent entries even when the plugin resets runtime before awaiting", () => {
    mocks.execute.mockImplementation(() => { useCanvasStore.getState().setRuntime("a", { status: "idle" }); return new Promise(() => {}); });
    expect(dispatchCommand({ type: "run", nodeId: "a" }, "gui")?.started).toBe(true);
    expect(dispatchCommand({ type: "run", nodeId: "a" }, "copilot")?.reason).toBe("busy");
    expect(commandBus.dispatch({ type: "run", nodeId: "a" }, { source: "agent", agentAutoMode: true })).toEqual({ started: false, reason: "busy" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("reserves before setRuntime subscribers can reenter the command", () => {
    let nested: unknown;
    const unsub = useCanvasStore.subscribe((s, previous) => {
      if (s.runtime.a?.status === "queued" && previous.runtime.a?.status !== "queued") nested = dispatchCommand({ type: "run", nodeId: "a" });
    });
    try { dispatchCommand({ type: "run", nodeId: "a" }); } finally { unsub(); }
    expect(nested).toEqual({ started: false, reason: "busy" });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it("does not execute a same-ID node if queued notification changes the active canvas", () => {
    const unsub = useCanvasStore.subscribe((s, previous) => {
      if (s.runtime.a?.status === "queued" && previous.runtime.a?.status !== "queued") {
        mocks.project.canvasEpisodeId = "ep2";
        useCanvasStore.setState({ runtime: {} });
      }
    });
    try { expect(dispatchCommand({ type: "run", nodeId: "a" })?.started).toBe(false); } finally { unsub(); }
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("settles rejected work and allows an explicit retry after completion", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.execute.mockRejectedValue(new Error("test failure"));
    dispatchCommand({ type: "run", nodeId: "a" });
    await flush();
    expect(useCanvasStore.getState().runtime.a.status).toBe("failed");
    expect(dispatchCommand({ type: "run", nodeId: "a" })?.started).toBe(true);
    await flush();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
  it("catches synchronous plugin errors and still blocks same-tick reentry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.execute.mockImplementation(() => { throw new Error("sync failure"); });
    expect(() => dispatchCommand({ type: "run", nodeId: "a" })).not.toThrow();
    expect(dispatchCommand({ type: "run", nodeId: "a" })?.reason).toBe("busy");
    await flush();
    expect(dispatchCommand({ type: "run", nodeId: "a" })?.started).toBe(true);
    await flush();
  });
  it("keeps independent scopes and prevents old failures from altering another canvas", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let reject!: (e: Error) => void;
    mocks.execute.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    dispatchCommand({ type: "run", nodeId: "a" });
    mocks.project.canvasEpisodeId = "ep2";
    useCanvasStore.setState({ runtime: {} });
    expect(dispatchCommand({ type: "run", nodeId: "a" })?.started).toBe(true);
    reject(new Error("old canvas")); await flush();
    expect(useCanvasStore.getState().runtime.a.status).toBe("queued");
    expect(dispatchCommand({ type: "run", nodeId: "a" })?.reason).toBe("busy");
    mocks.project.projectInstanceId = "other-project";
    useCanvasStore.setState({ runtime: {} });
    expect(dispatchCommand({ type: "run", nodeId: "a" })?.started).toBe(true);
  });
  it("hides and rejects upload, seed, readonly, groups and unknown plugin nodes", () => {
    for (const n of [node("upload", "upload"), node("seed", "text.seed"), node("readonly", "image.gen", { resultOnly: true }), node("group", "group"), node("unknown", "unknown")]) {
      useCanvasStore.getState().addNode(n);
      expect(isRunnableNode(n, getPlugin(n.type))).toBe(false);
      expect(dispatchCommand({ type: "run", nodeId: n.id })).toEqual({ started: false, reason: "unavailable" });
      expect(useCanvasStore.getState().runtime[n.id]?.status).not.toBe("queued");
    }
    expect(dispatchCommand({ type: "run", nodeId: "missing" })?.reason).toBe("missing");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("reports accepted starts and skipped items rather than selection size", () => {
    useCanvasStore.getState().addNode(node("seed", "text.seed"));
    useCanvasStore.getState().setRuntime("b", { status: "running" });
    expect(runSelectedNodes(["a", "a", "b", "seed", "missing", "c"])).toEqual({ started: 2, skipped: 3 });
    expect(mocks.execute.mock.calls.map((c) => c[0])).toEqual(["a", "c"]);
    expect(useRunSelectionFeedback.getState().message).toBe("已启动 2 个，已跳过 3 个");
  });
});

describe("one deletion gesture, one history entry", () => {
  it.each(["deleteNode", "deleteElements"] as const)("%s keeps the original file and project reference available for undo", (type) => {
    const original = node("file", "file", { localPath: "C:/audit/original.png", fileId: "file-1" });
    // Model the external resources separately from structural snapshots: a destructive call
    // would remove them, and undo could not restore them.
    const files = new Map([["C:/audit/original.png", new Uint8Array([1, 2, 3])]]);
    const fileRefs = new Map([["file-1", "C:/audit/original.png"]]);
    mocks.deleteFile.mockImplementation((path: string) => files.delete(path));
    mocks.removeFileRef.mockImplementation((id: string) => fileRefs.delete(id));
    useCanvasStore.getState().addNode(original);
    dispatchCommand(type === "deleteNode" ? { type, id: "file" } : { type, nodeIds: ["file"] });
    expect(useCanvasStore.getState().nodes.file).toBeUndefined();
    dispatchCommand({ type: "undo" });
    const restored = useCanvasStore.getState().nodes.file;
    expect(restored).toEqual(original);
    expect(files.get(fileRefs.get(restored.data.params.fileId as string)!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    expect(mocks.removeFileRef).not.toHaveBeenCalled();
  });
  it("undo/redo restore nodes, attached edges, independent selected edges and group membership together", () => {
    const nodes: Record<string, CanvasNode> = { ...useCanvasStore.getState().nodes, g: node("g", "group") };
    nodes.a = { ...nodes.a, parentId: "g" }; nodes.b = { ...nodes.b, parentId: "g" };
    const edges = { ab: edge("ab", "a", "b"), cd: edge("cd", "c", "d") };
    const groups = { g: { id: "g", childIds: ["a", "b"], x: 0, y: 0 } };
    useCanvasStore.setState({ nodes, edges, groups });
    useUiStore.setState({ selectedNodeIds: ["a", "b"], selectedEdgeIds: ["ab", "cd"], activeNodeId: "a" });
    dispatchCommand({ type: "deleteElements", nodeIds: ["a", "a", "b"], edgeIds: ["ab", "cd"] });
    expect(useCanvasStore.getState().past).toHaveLength(1);
    expect(Object.keys(useCanvasStore.getState().edges)).toHaveLength(0);
    expect(useUiStore.getState().selectedNodeIds).toEqual([]);
    expect(useUiStore.getState().activeNodeId).toBeNull();
    dispatchCommand({ type: "undo" });
    expect(useCanvasStore.getState().nodes).toEqual(nodes);
    expect(useCanvasStore.getState().edges).toEqual(edges);
    expect(useCanvasStore.getState().groups).toEqual(groups);
    dispatchCommand({ type: "redo" });
    expect(useCanvasStore.getState().nodes.a).toBeUndefined();
    expect(useCanvasStore.getState().nodes.b).toBeUndefined();
    expect(useCanvasStore.getState().edges).toEqual({});
  });
  it("edge-only batches undo together and stale/empty selections create no undo entry", () => {
    const edges = { ab: edge("ab", "a", "b"), cd: edge("cd", "c", "d") };
    useCanvasStore.setState({ edges });
    dispatchCommand({ type: "deleteElements", edgeIds: ["ab", "cd"] });
    expect(useCanvasStore.getState().past).toHaveLength(1);
    dispatchCommand({ type: "undo" });
    expect(useCanvasStore.getState().edges).toEqual(edges);
    dispatchCommand({ type: "deleteElements", nodeIds: ["missing"], edgeIds: [] });
    expect(useCanvasStore.getState().past).toHaveLength(0);
    expect(useCanvasStore.getState().future).toHaveLength(1);
  });
});
