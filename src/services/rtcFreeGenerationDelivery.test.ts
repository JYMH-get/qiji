import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ state: {} as any, library: {} as Record<string, any>, saved: new Map<string, string>(), disk: undefined as any, diskLibrary: {} as Record<string, any>, download: vi.fn(), probe: vi.fn(), writer: true, pathListener: undefined as undefined | ((state: any, previous: any) => void) }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.state, subscribe: (listener: any) => { h.pathListener = listener; return () => {}; } }, resolveEpisodeKey: () => "episode-B" }));
vi.mock("@/store/rtcStore", () => ({ useRtcStore: { getState: () => ({ doc: null }) } }));
vi.mock("@/rtc/panel/rtcQueueStore", () => ({ useRtcQueueStore: { getState: () => ({ setInfo: vi.fn() }) } }));
vi.mock("./assetPersist", () => ({ saveRemoteAsset: h.download, uploadBlobToOss: vi.fn(async b => b) }));
vi.mock("./managedClient", () => ({ managedClient: { rehost: vi.fn() } }));
vi.mock("./windowSync", () => ({ isProjectWriter: () => h.writer }));
vi.mock("@/canvas/videoCapture", () => ({ probeVideoDuration: h.probe }));
vi.mock("@/store/libraryStore", () => ({ useLibraryStore: { getState: () => ({ assets: h.library, addAsset: (asset: any) => { h.library = { ...h.library, [asset.id]: asset }; } }) } }));
const owner = { projectInstanceId: "project-A", savePath: "A.Qiji" };
const target = { episodeId: "episode-A", segId: "seg" };
const taskRef = "adapter|task";
const result = { uri: "https://fixture.invalid/free.mp4", media: "video" as const, taskId: "task" };
const currentSeg = () => h.state.rtcDocs["episode-A"].tracks[0].segments[0];
function setup(data?: any, identity = "project-A") {
  h.library = {};
  h.state = { projectInstanceId: identity, savePath: "A.Qiji", isProjectLoading: false, isDirty: false, assetBlobs: {},
    rtcDocs: data ?? { "episode-A": { tracks: [{ id: "track", segments: [{ id: "seg", kind: "placeholder", status: "running", taskRef, targetStartUs: 0, targetDurationUs: 5000000 }] }] } },
    registerAssetBlob: vi.fn(), blobByUri: () => undefined, markDirty: () => { h.state.isDirty = true; },
    setRtcEpisodeDoc: vi.fn((ep: string, doc: any) => { h.state.rtcDocs = { ...h.state.rtcDocs, [ep]: doc }; h.state.isDirty = true; }),
    save: vi.fn(async () => { h.disk = JSON.parse(JSON.stringify(h.state.rtcDocs)); h.diskLibrary = JSON.parse(JSON.stringify(h.library)); h.state.isDirty = false; }) };
}
const service = () => import("./rtcFreeGenerationDelivery");
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.saved.clear(); h.writer = true; h.download.mockResolvedValue(null); h.probe.mockResolvedValue(6); setup();
  vi.stubGlobal("localStorage", { getItem: (k: string) => h.saved.get(k) ?? null, setItem: (k: string, v: string) => h.saved.set(k, v), removeItem: (k: string) => h.saved.delete(k),
    key: (i: number) => [...h.saved.keys()][i] ?? null, get length() { return h.saved.size; } });
});
afterEach(() => vi.unstubAllGlobals());
describe("free RTC durable task/result receipts", () => {
  it("acceptance arriving on B is only recoverable at A's original path after restart", async () => {
    const s = await service(); setup(undefined, "project-B"); h.state.savePath = "B.Qiji";
    s.rememberFreeRtcTask(owner, target, taskRef); vi.resetModules(); const reopened = await service();
    expect(reopened.receivedFreeRtcTasks({ projectInstanceId: "B", savePath: "B.Qiji" })).toEqual([]);
    expect(reopened.receivedFreeRtcTasks({ projectInstanceId: "A-reopen", savePath: "A.Qiji" })).toEqual([{ target, taskRef }]);
  });
  it("a newer accepted task owns the target and late old completion cannot replace it", async () => {
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcTask(owner, target, "adapter|new");
    s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    expect(s.readFreeRtcCompletion(owner, target, taskRef)).toBeUndefined();
    expect(s.receivedFreeRtcTasks(owner)).toEqual([{ target, taskRef: "adapter|new" }]);
  });
  it("an old result stored on a reused placeholder cannot be mistaken for the new task", async () => {
    currentSeg().taskRef = "adapter|new"; currentSeg().rtcResult = result;
    const s = await service();
    expect(s.readFreeRtcCompletion(owner, target, "adapter|new")).toBeUndefined();
    s.rememberFreeRtcTask(owner, target, "adapter|new"); s.rememberFreeRtcCompletion(owner, target, "adapter|new", result);
    expect(s.readFreeRtcCompletion(owner, target, "adapter|new")).toBeUndefined();
  });
  it("a new accepted retry survives restart over its explicitly superseded failed disk task", async () => {
    currentSeg().status = "failed"; const oldDoc = JSON.parse(JSON.stringify(h.state.rtcDocs));
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef);
    s.rememberFreeRtcTask(owner, target, "adapter|new", taskRef);
    s.rememberFreeRtcCompletion(owner, target, "adapter|new", { ...result, taskId: "new", uri: "https://fixture.invalid/new.mp4" });
    vi.resetModules(); setup(oldDoc, "A-reopen"); const reopened = await service(), reopenedOwner = { ...owner, projectInstanceId: "A-reopen" };
    const [receipt] = reopened.receivedFreeRtcTasks(reopenedOwner);
    expect(receipt.supersededTaskRefs).toContain(currentSeg().taskRef);
    const sink = await import("@/rtc/panel/rtcGenSink"); sink.armRunning(target.segId, receipt.taskRef, reopenedOwner.projectInstanceId, { target });
    expect(await reopened.deliverFreeRtcCompletion({ owner: reopenedOwner, target, taskRef: receipt.taskRef })).toBe(true);
    expect(currentSeg()).toMatchObject({ kind: "media", uri: "https://fixture.invalid/new.mp4", resultTaskRef: "adapter|new" });
  });
  it("multiple unsaved retries preserve the exact supersession chain through terminal and restart", async () => {
    const s = await service(); s.rememberFreeRtcTask(owner, target, "adapter|first", taskRef);
    s.rememberFreeRtcTask(owner, target, "adapter|second", "adapter|first");
    s.rememberFreeRtcCompletion(owner, target, "adapter|second", { ...result, taskId: "second" });
    s.rememberFreeRtcTask(owner, target, "adapter|second");
    vi.resetModules(); const reopened = await service();
    expect(reopened.receivedFreeRtcTasks(owner)).toEqual([{ target, taskRef: "adapter|second", supersededTaskRefs: [taskRef, "adapter|first"] }]);
    expect(reopened.readFreeRtcCompletion(owner, target, "adapter|second")?.taskId).toBe("second");
  });
  it("an old receipt cannot restore over a newer unrelated disk task after restart", async () => {
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef, "adapter|older"); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    currentSeg().taskRef = "adapter|newer"; const newerDoc = JSON.parse(JSON.stringify(h.state.rtcDocs));
    vi.resetModules(); setup(newerDoc, "A-reopen"); const reopened = await service(), reopenedOwner = { ...owner, projectInstanceId: "A-reopen" };
    const [receipt] = reopened.receivedFreeRtcTasks(reopenedOwner);
    expect(receipt.supersededTaskRefs).not.toContain(currentSeg().taskRef);
    await reopened.deliverFreeRtcCompletion({ owner: reopenedOwner, target, taskRef: receipt.taskRef });
    expect(currentSeg()).toMatchObject({ kind: "placeholder", taskRef: "adapter|newer" });
    expect(Object.values(h.library)).toEqual([expect.objectContaining({ uri: result.uri, episodeId: target.episodeId })]);
  });
  it("raw-result save failure replays only its receipt after restart", async () => {
    const oldDoc = JSON.parse(JSON.stringify(h.state.rtcDocs)); const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    h.state.save.mockRejectedValue(new Error("disk-full"));
    expect(await s.deliverFreeRtcCompletion({ owner, target, taskRef })).toBe(false); expect(currentSeg().kind).toBe("placeholder");
    vi.resetModules(); setup(oldDoc, "A-reopen"); const reopened = await service();
    expect(await reopened.deliverFreeRtcCompletion({ owner: { ...owner, projectInstanceId: "A-reopen" }, target, taskRef })).toBe(true);
    expect(currentSeg()).toMatchObject({ kind: "media", uri: result.uri, resultTaskRef: taskRef }); expect(h.saved.size).toBe(0);
  });
  it("post-land save failure retains receipt, reopened media is acknowledged without downloading twice", async () => {
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    h.state.save.mockImplementation(async () => { h.disk = JSON.parse(JSON.stringify(h.state.rtcDocs)); h.state.isDirty = currentSeg().kind === "media"; });
    expect(await s.deliverFreeRtcCompletion({ owner, target, taskRef })).toBe(false); expect(h.saved.size).toBe(1);
    vi.resetModules(); setup(h.disk, "A-reopen");
    expect(await (await service()).deliverFreeRtcCompletion({ owner: { ...owner, projectInstanceId: "A-reopen" }, target, taskRef })).toBe(true);
    expect(h.download).toHaveBeenCalledOnce(); expect(h.probe).toHaveBeenCalledOnce(); expect(h.saved.size).toBe(0);
  });
  it("placeholder guard becoming false after landing does not prevent confirmed save", async () => {
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    expect(await s.deliverFreeRtcCompletion({ owner, target, taskRef, shouldContinue: () => currentSeg().kind === "placeholder" })).toBe(true);
    expect(h.saved.size).toBe(0);
  });
  it("non-writer releases delivery while preserving its independent receipt", async () => {
    h.writer = false; const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    expect(await s.deliverFreeRtcCompletion({ owner, target, taskRef })).toBe(true); expect(currentSeg().kind).toBe("media"); expect(h.saved.size).toBe(1);
  });
  it("deleted target is never recreated while its paid result is retained in the episode library", async () => {
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    h.state.rtcDocs["episode-A"].tracks[0].segments = [];
    expect(await s.deliverFreeRtcCompletion({ owner, target, taskRef })).toBe(true); expect(currentSeg()).toBeUndefined(); expect(h.download).toHaveBeenCalledOnce();
    expect(Object.values(h.library)).toEqual([expect.objectContaining({ kind: 'video', uri: result.uri, episodeId: target.episodeId, origin: 'generated' })]);
    expect(Object.keys(h.diskLibrary)).toHaveLength(1); expect(h.saved.size).toBe(0);
  });
  it("task state shares the durable receipt while live percentage stays in memory", async () => {
    const s = await service();
    s.rememberFreeRtcPreparation(owner, target, { media: 'image', name: '原图片', createdAt: 100 }, 'adapter|old');
    expect(s.getFreeRtcGenerationTasks(owner)).toEqual([expect.objectContaining({ target, media: 'image', name: '原图片', status: 'preparing' })]);
    s.rememberFreeRtcTask(owner, target, taskRef, 'adapter|old'); const persisted = [...h.saved.values()][0];
    s.updateFreeRtcTask(owner, target, { progress: 48 }, false);
    expect([...h.saved.values()][0]).toBe(persisted); expect(s.getFreeRtcGenerationTasks(owner)[0].progress).toBe(48);
    vi.resetModules(); const reopened = await service();
    expect(reopened.getFreeRtcGenerationTasks(owner)[0].progress).toBeUndefined();
    expect(reopened.receivedFreeRtcTasks(owner)[0].supersededTaskRefs).toEqual(['adapter|old']);
    expect(reopened.getFreeRtcGenerationTasks({ projectInstanceId: 'other', savePath: 'other.Qiji' })).toEqual([]);
  });
  it("preparing a retry preserves the previously proven supersession chain", async () => {
    const s = await service();
    s.rememberFreeRtcTask(owner, target, 'adapter|first', 'adapter|original');
    s.rememberFreeRtcPreparation(owner, target, { media: 'video', name: '重试', createdAt: 100 }, 'adapter|first');
    s.rememberFreeRtcTask(owner, target, 'adapter|second', 'adapter|first');
    expect(s.receivedFreeRtcTasks(owner)[0].supersededTaskRefs).toEqual(['adapter|original', 'adapter|first']);
  });
  it("deleting a placement during download still keeps the completed media", async () => {
    let release!: (value: any) => void;
    h.download.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    const delivered = s.deliverFreeRtcCompletion({ owner, target, taskRef });
    await vi.waitFor(() => expect(h.download).toHaveBeenCalledOnce());
    h.state.rtcDocs['episode-A'].tracks[0].segments = [];
    release({ id: 'video-result', url: result.uri, localUri: 'local://downloaded' });
    expect(await delivered).toBe(true); expect(currentSeg()).toBeUndefined();
    expect(Object.values(h.library)).toEqual([expect.objectContaining({ uri: 'local://downloaded', serverAssetId: 'video-result', episodeId: 'episode-A' })]);
  });
  it("deleted-target library save failure survives restart without downloading twice", async () => {
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    h.state.rtcDocs['episode-A'].tracks[0].segments = [];
    h.state.save.mockImplementation(async () => { h.disk = JSON.parse(JSON.stringify(h.state.rtcDocs)); h.state.isDirty = Object.keys(h.library).length > 0; });
    expect(await s.deliverFreeRtcCompletion({ owner, target, taskRef })).toBe(false); expect(h.saved.size).toBe(1);
    vi.resetModules(); setup(h.disk, 'A-reopen'); const reopened = await service();
    expect(await reopened.deliverFreeRtcCompletion({ owner: { ...owner, projectInstanceId: 'A-reopen' }, target, taskRef })).toBe(true);
    expect(currentSeg()).toBeUndefined(); expect(Object.keys(h.library)).toHaveLength(1);
    expect(h.download).toHaveBeenCalledOnce(); expect(h.saved.size).toBe(0);
  });
  it("switching projects during download writes no foreign library and keeps A's receipt", async () => {
    let release!: (value: any) => void;
    h.download.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    h.state.rtcDocs['episode-A'].tracks[0].segments = [];
    const originalDoc = JSON.parse(JSON.stringify(h.state.rtcDocs));
    const pending = s.deliverFreeRtcCompletion({ owner, target, taskRef }); await vi.waitFor(() => expect(h.download).toHaveBeenCalledOnce());
    setup(undefined, 'B'); h.state.savePath = 'B.Qiji';
    release({ id: 'video-result', url: result.uri, localUri: 'local://downloaded' });
    expect(await pending).toBe(false); expect(h.library).toEqual({}); expect(h.saved.size).toBe(1);
    setup(originalDoc, 'A-reopen');
    expect(await s.deliverFreeRtcCompletion({ owner: { ...owner, projectInstanceId: 'A-reopen' }, target, taskRef })).toBe(true);
    expect(Object.values(h.library)[0]).toMatchObject({ episodeId: 'episode-A', uri: result.uri }); expect(currentSeg()).toBeUndefined();
  });
  it("replay does not resurrect a library item the user already soft-deleted", async () => {
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    h.state.rtcDocs['episode-A'].tracks[0].segments = [];
    h.state.save.mockImplementation(async () => { h.state.isDirty = Object.keys(h.library).length > 0; });
    expect(await s.deliverFreeRtcCompletion({ owner, target, taskRef })).toBe(false);
    const [id] = Object.keys(h.library); h.library[id] = { ...h.library[id], deletedByUser: true, name: '我的改名' };
    h.state.save.mockImplementation(async () => { h.state.isDirty = false; });
    expect(await s.deliverFreeRtcCompletion({ owner, target, taskRef })).toBe(true);
    expect(Object.keys(h.library)).toEqual([id]); expect(h.library[id]).toMatchObject({ deletedByUser: true, name: '我的改名' });
  });
  it("non-writer removes its completed UI placeholder while retaining the durable receipt", async () => {
    h.writer = false; const s = await service();
    s.rememberFreeRtcPreparation(owner, target, { media: 'video', name: '自由视频', createdAt: 100 });
    s.rememberFreeRtcTask(owner, target, taskRef); s.rememberFreeRtcCompletion(owner, target, taskRef, result);
    h.state.rtcDocs['episode-A'].tracks[0].segments = [];
    expect(s.getFreeRtcGenerationTasks(owner)).toHaveLength(1);
    expect(await s.deliverFreeRtcCompletion({ owner, target, taskRef })).toBe(true);
    expect(s.getFreeRtcGenerationTasks(owner)).toEqual([]); expect(h.saved.size).toBe(1); expect(Object.keys(h.library)).toHaveLength(1);
  });
  it("Save As moves only the same task receipt and remains restorable at the new path", async () => {
    const s = await service(); s.rememberFreeRtcPreparation(owner, target, { media: 'image', name: '未命名图', createdAt: 100 });
    const savedAs = { ...owner, savePath: 'new-path.Qiji' }; s.moveFreeRtcReceipt(owner, savedAs, target);
    s.rememberFreeRtcTask(savedAs, target, taskRef);
    vi.resetModules(); const reopened = await service();
    expect(reopened.receivedFreeRtcTasks(owner)).toEqual([]);
    expect(reopened.receivedFreeRtcTasks({ ...savedAs, projectInstanceId: 'new-open' })).toEqual([expect.objectContaining({ taskRef, media: 'image', status: 'running' })]);
  });
  it("first save moves an accepted unsaved receipt immediately without waiting for progress", async () => {
    const s = await service(), unsavedOwner = { ...owner, savePath: null };
    h.state.savePath = null;
    s.rememberFreeRtcPreparation(unsavedOwner, target, { media: 'image', name: '未保存图片', createdAt: 100 });
    s.rememberFreeRtcTask(unsavedOwner, target, taskRef);
    const previous = h.state; h.state = { ...h.state, savePath: 'first-save.Qiji' }; h.pathListener!(h.state, previous);
    const savedOwner = { ...owner, savePath: 'first-save.Qiji' };
    expect(s.getFreeRtcGenerationTasks(savedOwner)).toHaveLength(1); expect(s.receivedFreeRtcTasks(unsavedOwner)).toEqual([]);
    vi.resetModules(); expect((await service()).receivedFreeRtcTasks({ ...savedOwner, projectInstanceId: 'reopened' })).toEqual([expect.objectContaining({ taskRef, media: 'image' })]);
  });
  it("a project switch cannot move another project's receipt to the new path", async () => {
    const s = await service(); s.rememberFreeRtcTask(owner, target, taskRef);
    const previous = h.state; h.state = { ...h.state, projectInstanceId: 'project-B', savePath: 'B.Qiji' }; h.pathListener!(h.state, previous);
    expect(s.receivedFreeRtcTasks(owner)).toEqual([{ target, taskRef }]);
    expect(s.receivedFreeRtcTasks({ projectInstanceId: 'project-B', savePath: 'B.Qiji' })).toEqual([]);
  });
  it("first save inside delivery follows the new path even if the final library save fails", async () => {
    const s = await service(), unsavedOwner = { ...owner, savePath: null }; h.state.savePath = null;
    h.state.rtcDocs['episode-A'].tracks[0].segments = [];
    s.rememberFreeRtcPreparation(unsavedOwner, target, { media: 'video', name: '新项目视频', createdAt: 100 });
    s.rememberFreeRtcTask(unsavedOwner, target, taskRef); s.rememberFreeRtcCompletion(unsavedOwner, target, taskRef, result);
    let saves = 0;
    h.state.save.mockImplementation(async () => {
      if (++saves > 1) throw new Error('final save failed');
      const previous = h.state; h.state = { ...h.state, savePath: 'first-save.Qiji', isDirty: false }; h.pathListener!(h.state, previous);
      h.disk = JSON.parse(JSON.stringify(h.state.rtcDocs));
    });
    expect(await s.deliverFreeRtcCompletion({ owner: unsavedOwner, target, taskRef })).toBe(false);
    const savedOwner = { ...owner, savePath: 'first-save.Qiji' };
    expect(s.getFreeRtcGenerationTasks(savedOwner)).toHaveLength(1); expect(s.receivedFreeRtcTasks(unsavedOwner)).toEqual([]);
    expect(s.readFreeRtcCompletion(savedOwner, target, taskRef)?.displayUri).toBe(result.uri);
    vi.resetModules(); setup(h.disk, 'new-open'); h.state.savePath = 'first-save.Qiji';
    expect(await (await service()).deliverFreeRtcCompletion({ owner: { ...savedOwner, projectInstanceId: 'new-open' }, target, taskRef })).toBe(true);
    expect(h.download).toHaveBeenCalledOnce(); expect(Object.keys(h.library)).toHaveLength(1); expect(h.saved.size).toBe(0);
  });
});
