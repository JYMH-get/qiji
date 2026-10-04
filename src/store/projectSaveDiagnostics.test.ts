import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  record: vi.fn(), create: vi.fn(), commits: {} as Record<string, any>,
  write: vi.fn(), exists: vi.fn(), rename: vi.fn(), invoke: vi.fn(), read: vi.fn(),
}));
vi.mock("@/services/clientDiagnostics", () => ({
  recordClientDiagnostic: m.record, classifyClientDiagnosticError: () => "type_error",
}));
vi.mock("./commitStore", () => ({
  useCommitStore: { getState: () => ({ createCommit: m.create, commits: m.commits, head: "head" }),
    setState: (state: { commits: Record<string, any> }) => { m.commits = state.commits; } },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: m.write, readTextFile: m.read, exists: m.exists, rename: m.rename, mkdir: vi.fn(), remove: vi.fn(),
}));
vi.mock("@tauri-apps/api/path", () => ({ join: async (...parts: string[]) => parts.join("/") }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke, convertFileSrc: (path: string) => `asset:${path}` }));
vi.mock("@/services/assetRefReport", () => ({ reportProjectAssetRefs: vi.fn() }));
vi.mock("@/services/projectAssetHeal", () => ({ healProjectAssetBlobs: vi.fn() }));
vi.mock("@/services/libraryHeal", () => ({ healLibraryAssets: vi.fn() }));
vi.mock("@/services/generationQueue", () => ({ resumePendingGenerations: vi.fn() }));
vi.mock("@/services/inferRun", () => ({ resumeInferTasks: vi.fn() }));
vi.mock("@/nodes/pluginRegistry", () => ({ resumeCanvasNodeTasks: vi.fn() }));
vi.mock("@/store/requestLedgerStore", () => ({ onProjectContextChanged: vi.fn() }));

import { useProjectStore } from "./projectStore";
import { useCanvasStore } from "./canvasStore";
import { useLibraryStore } from "./libraryStore";
import { useSettingsStore } from "./settingsStore";
import { cancelAllSaves, scheduleSave } from "./debouncedSave";

describe("原生保存诊断与快照隔离", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cancelAllSaves();
    for (const mock of [m.record, m.create, m.write, m.exists, m.rename, m.invoke, m.read]) mock.mockReset();
    m.record.mockResolvedValue(undefined); m.create.mockResolvedValue("head");
    m.write.mockResolvedValue(undefined); m.exists.mockResolvedValue(true);
    m.rename.mockResolvedValue(undefined); m.invoke.mockResolvedValue(undefined);
    m.commits = {};
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("localStorage", { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() });
    useProjectStore.setState({ projectInstanceId: "fixture-a", name: "fixture", savePath: "D:/fixture/project.Qiji",
      isProjectLoading: false, isSaving: false, isDirty: true, fileRefs: {}, recentProjects: [],
      canvases: {}, episodes: [], assetBlobs: {}, genMeta: {}, assetRefImages: {}, rtcDocs: {} });
    useCanvasStore.setState({ nodes: {}, edges: {}, groups: {}, runtime: {}, past: [], future: [] });
    useLibraryStore.setState({ assets: {} });
    useSettingsStore.setState({ enableCloudSync: false });
    vi.spyOn(useSettingsStore.getState(), "setLastOpenedProjectPath").mockImplementation(() => {});
  });
  afterEach(() => { cancelAllSaves(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("序列化开始前已有原生日志，写盘前已有大小与阶段，成功包含同一saveId", async () => {
    m.write.mockImplementation(async () => {
      const events = m.record.mock.calls.map(([event]) => event);
      expect(events.map(event => event.kind)).toContain("save_serialized");
      expect(events[events.length - 1].stage).toBe("write");
    });
    await useProjectStore.getState().save();
    const events = m.record.mock.calls.map(([event]) => event);
    expect(events.map(event => [event.kind, event.stage])).toEqual([
      ["save_start", "snapshot"], ["save_stage", "normalize"], ["save_stage", "serialize"],
      ["save_serialized", "serialize"], ["save_stage", "write"], ["save_success", "finish"],
    ]);
    expect(new Set(events.map(event => event.saveId)).size).toBe(1);
    expect(events[3].jsonChars).toBe(m.write.mock.calls[0][1].length);
    expect(JSON.stringify(events)).not.toContain("D:/fixture");
  });

  it("保存路径归一化只改落盘副本，冻结的历史与素材库不被写穿", async () => {
    const asset = Object.freeze({ id: "asset", localPath: "D:/original/a.png", uri: "asset:original" });
    const assets = Object.freeze({ asset });
    const commit = Object.freeze({ commitId: "head", canvas: { nodes: {}, edges: {}, groups: {} }, assets });
    m.commits = Object.freeze({ head: commit });
    const files = Object.freeze({ asset: "D:/original/a.png" });
    useProjectStore.setState({ fileRefs: files });
    useLibraryStore.setState({ assets: assets as never });
    await useProjectStore.getState().save();
    expect(m.write).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(m.write.mock.calls[0][1]);
    expect(saved.commits.head.assets.asset.localPath).toBe("D:/fixture/assets/a.png");
    expect(saved.files.asset).toBe("D:/fixture/assets/a.png");
    expect(useLibraryStore.getState().assets.asset.localPath).toBe("D:/original/a.png");
    expect(useProjectStore.getState().fileRefs.asset).toBe("D:/original/a.png");
  });

  it("序列化失败记录失败阶段并保留重试，不写半截文件", async () => {
    const node: any = { id: "n" }; node.self = node;
    useCanvasStore.setState({ nodes: { n: node } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await useProjectStore.getState().save();
    expect(m.write).not.toHaveBeenCalled();
    expect(m.record.mock.calls[m.record.mock.calls.length - 1]?.[0]).toMatchObject({ kind: "save_failed", stage: "serialize", errorClass: "type_error" });
    expect(useProjectStore.getState().isDirty).toBe(true);
    useCanvasStore.setState({ nodes: {} });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.write).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  it("等待诊断时切项目取消旧快照，不能拿新项目内容写旧文件", async () => {
    let release!: () => void;
    m.record.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const saving = useProjectStore.getState().save();
    useProjectStore.setState({ projectInstanceId: "fixture-b", savePath: "D:/b/project.Qiji", isDirty: true });
    release(); await saving;
    expect(m.create).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
    expect(useProjectStore.getState().isDirty).toBe(true);
  });

  it("旧文件写盘期间切项目并请求新保存，串行写两份各自快照", async () => {
    let release!: () => void;
    m.write.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const oldSave = useProjectStore.getState().save();
    await vi.waitFor(() => expect(m.write).toHaveBeenCalledTimes(1));
    useProjectStore.setState({ projectInstanceId: "fixture-b", savePath: "D:/b/project.Qiji", name: "second", isDirty: true });
    scheduleSave();
    const newSave = useProjectStore.getState().save(true);
    release(); await Promise.all([oldSave, newSave]);
    expect(m.write.mock.calls.map(([path]) => path)).toEqual(["D:/fixture/project.Qiji.tmp", "D:/b/project.Qiji.tmp"]);
    expect(m.write.mock.calls.map(([, data]) => JSON.parse(data).name)).toEqual(["fixture", "second"]);
    expect(useProjectStore.getState().savePath).toBe("D:/b/project.Qiji");
    expect(useProjectStore.getState().isDirty).toBe(false);
  });

  it("关键结果立即写盘但更新自动恢复点，显式手动保存才创建独立版本", async () => {
    await useProjectStore.getState().save(true);
    expect(m.create.mock.calls[0][1].automatic).toBe(true);
    expect(m.record.mock.calls[0][0].source).toBe("checkpoint");
    await useProjectStore.getState().save(true, true);
    expect(m.create.mock.calls[1][1].automatic).toBe(false);
    expect(m.record.mock.calls[m.record.mock.calls.length - 1]?.[0].source).toBe("manual");
  });

  it("从.tmp恢复损坏主文件后，加载就绪立即把恢复内容写回主文件", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    m.read.mockRejectedValueOnce(new Error("corrupt main")).mockResolvedValueOnce(JSON.stringify({
      version: "2.0", name: "recovered", nodes: {}, edges: {}, groups: {}, commits: {},
    }));
    expect(await useProjectStore.getState().loadFromPath("D:/fixture/project.Qiji")).toBe(true);
    expect(m.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(m.write.mock.calls[0][1]).name).toBe("recovered");
    expect(m.rename).toHaveBeenCalledWith("D:/fixture/project.Qiji.tmp", "D:/fixture/project.Qiji");
    expect(useProjectStore.getState().isProjectLoading).toBe(false);
  });

  it("打开别的损坏项目打断当前保存后，仍为原项目安排自动重试", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let releaseDiagnostic!: () => void;
    let rejectRead!: (error: Error) => void;
    m.record.mockImplementationOnce(() => new Promise<void>(resolve => { releaseDiagnostic = resolve; }));
    m.read.mockRejectedValue(new Error("missing backup"));
    m.read.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const saving = useProjectStore.getState().save();
    const loading = useProjectStore.getState().loadFromPath("D:/broken/project.Qiji");
    await vi.waitFor(() => expect(m.read).toHaveBeenCalled());
    releaseDiagnostic(); await saving;
    expect(m.write).not.toHaveBeenCalled();
    rejectRead(new Error("corrupt"));
    expect(await loading).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.write.mock.calls[0][0]).toBe("D:/fixture/project.Qiji.tmp");
    expect(useProjectStore.getState().isDirty).toBe(false);
  });
});
