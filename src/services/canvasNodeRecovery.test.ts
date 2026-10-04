import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@/types";
import type { TaskUpdate } from "@/services/taskCenter";

const io = vi.hoisted(() => ({ submit: vi.fn(), handlers: new Map<string, TaskUpdate>(), track: vi.fn() }));
vi.mock("@/services/modelAdapter", () => ({ getAdapter: () => ({ key: "fixture-image", submit: io.submit }), registerAdapter: vi.fn() }));
vi.mock("@/services/adapters/registry", () => ({ getAdapter: () => ({ key: "fixture-image", submit: io.submit }), registerAdapter: vi.fn() }));
vi.mock("@/services/adapters/channelAdapter", () => ({ resolveActiveModelKey: () => "fixture-image" }));
vi.mock("@/services/taskCenter", () => ({ trackTask: (input: { taskId: string; onUpdate: TaskUpdate }) => {
  io.track(input); io.handlers.set(input.taskId, input.onUpdate);
} }));
vi.mock("@/services/projectSync", () => ({ broadcastCanvasSnapshot: vi.fn() }));
vi.mock("@/store/debouncedSave", () => ({ initDebouncedSave: vi.fn(), scheduleSave: vi.fn(), notifySaved: vi.fn(), flushScheduledSave: vi.fn(), getSaveRevision: () => 0, cancelAllSaves: vi.fn() }));
vi.mock("@/services/windowSync", () => ({ isProjectWriter: () => true, isPrimaryWindow: () => true, peersHaveProject: () => false }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: async () => true }));
vi.mock("@/services/assetRefReport", () => ({ reportProjectAssetRefs: vi.fn(), resetAssetRefThrottle: vi.fn() }));

import { useProjectStore as ps } from "@/store/projectStore";
import { useCanvasStore as cs } from "@/store/canvasStore";
import { useRequestLedgerStore as ls } from "@/store/requestLedgerStore";
import { defaultNodeExecute, isCanvasTaskTracked } from "@/nodes/pluginRegistry";

const task = { taskId: "accepted-image-task", adapterKey: "fixture-image", startedAt: 1 };
const imageNode = (): CanvasNode => ({ id: "image", type: "image.gen", x: 0, y: 0, w: 240, h: 240,
  parentId: null, parentScriptId: null, data: { input: {}, params: {}, resultAssetId: null, task: { ...task } } });
const pollReady = async () => vi.waitFor(() => expect(io.handlers.has(task.taskId), JSON.stringify(cs.getState().runtime)).toBe(true));
const finish = (status: "lost" | "failed") => io.handlers.get(task.taskId)!(100, status, undefined, `synthetic ${status}`);

beforeEach(() => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  io.submit.mockReset(); io.track.mockReset(); io.handlers.clear();
  ps.setState({ savePath: "D:/fixture/recovery.Qiji", name: "Recovery", projectInstanceId: "recovery-instance", isProjectLoading: false,
    canvasEpisodeId: "episode", episodes: [{ id: "episode", index: 1, title: "Episode", scriptText: "", shots: [] }],
    canvases: {}, save: vi.fn(async () => {}), scheduleAutoSave: vi.fn() });
  cs.setState({ nodes: { image: imageNode() }, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
  ls.setState({ entries: [] });
});
afterEach(() => vi.unstubAllGlobals());

describe("ordinary node recovery through the real purpose runner and ledger", () => {
  it("uses serialized accepted credentials without submitting a replacement", async () => {
    cs.setState({ nodes: JSON.parse(JSON.stringify(cs.getState().nodes)) });
    const run = defaultNodeExecute("image"); await pollReady();
    expect(io.submit).not.toHaveBeenCalled();
    expect(io.track).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.taskId, adapterKey: task.adapterKey }));
    finish("failed"); await run;
    expect(cs.getState().nodes.image.data.task).toBeUndefined();
    expect(cs.getState().runtime.image.status).toBe("failed");
    await vi.waitFor(() => expect(ls.getState().entries).toHaveLength(0));
  });

  it("retains lost credentials and reconnects the same task until a confirmed terminal failure", async () => {
    const first = defaultNodeExecute("image"); await pollReady(); finish("lost"); await first;
    expect(cs.getState().nodes.image.data.task).toEqual(task);
    expect(cs.getState().runtime.image).toMatchObject({ status: "failed", error: "synthetic lost" });
    expect(isCanvasTaskTracked(task.taskId)).toBe(false);
    await vi.waitFor(() => expect(ls.getState().entries).toHaveLength(1));
    io.handlers.clear();
    const retry = defaultNodeExecute("image"); await pollReady();
    expect(io.submit).not.toHaveBeenCalled();
    expect(io.track).toHaveBeenCalledTimes(2);
    finish("failed"); await retry;
    expect(cs.getState().nodes.image.data.task).toBeUndefined();
    expect(isCanvasTaskTracked(task.taskId)).toBe(false);
    await vi.waitFor(() => expect(ls.getState().entries).toHaveLength(0));
  });

  it("preserves accepted credentials after a local reconnect exception", async () => {
    io.track.mockImplementation(() => { throw Error("synthetic tracker unavailable"); });
    await defaultNodeExecute("image");
    expect(io.submit).not.toHaveBeenCalled();
    expect(cs.getState().nodes.image.data.task).toEqual(task);
    expect(cs.getState().runtime.image).toMatchObject({ status: "failed", error: "synthetic tracker unavailable" });
    expect(isCanvasTaskTracked(task.taskId)).toBe(false);
  });
});
