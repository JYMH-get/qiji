import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ state: {} as any, rtc: {} as any, library: {} as any, disk: undefined as any, saved: new Map<string, string>(),
  run: vi.fn(), track: vi.fn(), download: vi.fn(), probe: vi.fn(), queueInfo: vi.fn(), freeResume: vi.fn(), writer: true,
  onChange: undefined as undefined | (() => void), saveImpl: undefined as undefined | (() => Promise<void>) }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.state }, resolveEpisodeKey: (id: string) => id }));
vi.mock("@/store/rtcStore", () => ({ useRtcStore: { getState: () => h.rtc } }));
vi.mock("@/store/libraryStore", () => ({ useLibraryStore: { getState: () => h.library } }));
vi.mock("@/rtc/panel/rtcQueueStore", () => ({ useRtcQueueStore: { getState: () => ({ setInfo: h.queueInfo }) } }));
vi.mock("./purposeRunner", () => ({ runPurpose: h.run }));
vi.mock("./taskCenter", () => ({ trackTask: h.track }));
vi.mock("./assetPersist", () => ({ saveRemoteAsset: h.download, uploadBlobToOss: vi.fn(async b => b) }));
vi.mock("./managedClient", () => ({ managedClient: { rehost: vi.fn() } }));
vi.mock("@/lib/presetSchemes", () => ({ resolvePresets: (p: string) => p }));
vi.mock("./windowSync", () => ({ isProjectWriter: () => h.writer }));
vi.mock("@/canvas/videoCapture", () => ({ probeVideoDuration: h.probe }));
vi.mock("@/rtc/panel/freeGenActions", () => ({ resumeFreeGens: h.freeResume }));
const target = { episodeId: "episode-A", segId: "seg-1" };
const url = "https://fixture.invalid/exact-result.mp4";
const pending = (id = "gen-1", explicit = true): any => ({ id, createdAt: 123, status: "running", taskId: `task-${id}`, adapterKey: "adapter",
  purpose: "video.generation", prompt: "p", label: "shot", shot: { episodeId: "episode-A", shotId: "shot-1", field: "video" },
  ...(explicit ? { rtcTarget: { ...target, segId: id === "gen-1" ? "seg-1" : "seg-2" } } : {}) });
const seg = (id = "seg-1", taskRef = "gen-1"): any => ({ id, kind: "placeholder", status: "running", taskRef, media: "video", targetStartUs: 4000000, targetDurationUs: 9000000,
  shotRef: { episodeId: "episode-A", shotId: "shot-1" } });
const doc = (segments: any[]): any => ({ tracks: [{ id: "track", kind: "video", segments }] });
const snapshot = () => JSON.parse(JSON.stringify({ pendingGens: h.state.pendingGens, rtcDocs: h.state.rtcDocs, episodes: h.state.episodes, assetBlobs: h.state.assetBlobs, assets: h.library.assets }));
function changed() { h.state.isDirty = true; h.onChange?.(); }
function setup(data?: any, identity = "project-A") {
  h.rtc = { doc: null, ownerProjectId: null, ownerEpisodeKey: null };
  h.library = { assets: data?.assets ?? {}, addAsset: vi.fn((asset: any) => { h.library.assets = { ...h.library.assets, [asset.id]: asset }; changed(); }) };
  h.state = { projectInstanceId: identity, savePath: "A.Qiji", isDirty: false, isProjectLoading: false, rtcEpisodeId: "episode-B",
    pendingGens: [pending()], rtcDocs: { "episode-A": doc([seg()]), "episode-B": doc([seg("other", "other-task")]) },
    episodes: [{ id: "episode-A", shots: [{ id: "shot-1", videoUris: [] }] }, { id: "episode-B", shots: [] }], assetBlobs: {},
    ...data,
    addPendingGen: vi.fn((p: any) => { h.state.pendingGens = [...h.state.pendingGens, p]; changed(); }),
    updatePendingGen: vi.fn((id: string, patch: any) => { h.state.pendingGens = h.state.pendingGens.map((p: any) => p.id === id ? { ...p, ...patch } : p); changed(); }),
    removePendingGen: vi.fn((id: string) => { h.state.pendingGens = h.state.pendingGens.filter((p: any) => p.id !== id); changed(); }),
    setRtcEpisodeDoc: vi.fn((id: string, next: any) => { h.state.rtcDocs = { ...h.state.rtcDocs, [id]: next }; changed(); }),
    updateShot: vi.fn((ep: string, sh: string, patch: any) => { h.state.episodes = h.state.episodes.map((e: any) => e.id === ep ? { ...e, shots: e.shots.map((s: any) => s.id === sh ? { ...s, ...patch } : s) } : e); changed(); }),
    registerAssetBlob: vi.fn((blob: any) => { h.state.assetBlobs = { ...h.state.assetBlobs, [blob.id]: blob }; }),
    blobByUri: (uri: string) => Object.values(h.state.assetBlobs).find((b: any) => [b.localUri, b.url, b.srcUri].includes(uri)),
    markDirty: changed, addGenMeta: vi.fn(), addAssetImage: vi.fn(),
    save: vi.fn(async () => { if (h.saveImpl) return h.saveImpl(); h.disk = snapshot(); h.state.isDirty = false; h.onChange?.(); }) };
}
const currentSeg = (id = "seg-1") => h.state.rtcDocs["episode-A"].tracks[0].segments.find((s: any) => s.id === id);
const wait = async () => { await new Promise(r => setTimeout(r, 0)); };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function queue() { return import("./generationQueue"); }
function complete(task = "task-gen-1", uri = url) { h.track.mock.calls.find(([x]) => x.taskId === task)![0].onUpdate(100, "success", uri, undefined, task); }
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); h.saved.clear(); h.onChange = undefined; h.saveImpl = undefined; h.writer = true;
  vi.stubGlobal("localStorage", { getItem: (k: string) => h.saved.get(k) ?? null, setItem: (k: string, v: string) => h.saved.set(k, v),
    removeItem: (k: string) => h.saved.delete(k), key: (i: number) => [...h.saved.keys()][i] ?? null, get length() { return h.saved.size; } });
  h.download.mockResolvedValue(null); h.probe.mockResolvedValue(12); setup();
});
afterEach(() => vi.unstubAllGlobals());

describe("RTC queue exact delivery and save checkpoints", () => {
  it("keeps the gap after a short result and moves linked followers only for a longer result", async () => {
    const follower = { ...seg("next", ""), kind: "media", targetStartUs: 13000000, targetDurationUs: 2000000, groupId: "pair" };
    h.state.rtcDocs["episode-A"].tracks.push({ id: "audio", type: "audio", segments: [{ ...follower, id: "audio-next" }] });
    h.state.rtcDocs["episode-A"].tracks[0].segments.push(follower);
    h.state.rtcDocs["episode-A"].markers = [{ id: "m", timeUs: 13000000 }];
    h.probe.mockResolvedValue(7);
    const q = await queue(); q.resumePendingGenerations(); complete();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0));
    expect(currentSeg().targetDurationUs).toBe(7000000);
    expect(currentSeg("next").targetStartUs).toBe(13000000);
    expect(h.state.rtcDocs["episode-A"].tracks[1].segments[0].targetStartUs).toBe(13000000);
    expect(h.state.rtcDocs["episode-A"].markers[0].timeUs).toBe(13000000);
  });

  it("pushes video audio text and markers once through receipt delivery", async () => {
    const follower = { ...seg("next", ""), kind: "media", targetStartUs: 13000000, targetDurationUs: 2000000, groupId: "pair" };
    const timeline = h.state.rtcDocs["episode-A"];
    timeline.tracks[0].segments.push(follower);
    for (const type of ["audio", "text"]) timeline.tracks.push({ id: type, type, segments: [{ ...follower, id: type + "-next" }] });
    timeline.markers = [{ id: "m", timeUs: 13000000 }];
    const q = await queue(); q.resumePendingGenerations(); complete();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0));
    q.resumeRtcPendingResults(); await wait();
    const delivered = h.state.rtcDocs["episode-A"];
    expect(currentSeg().targetDurationUs).toBe(12000000);
    expect(delivered.tracks.flatMap((t: any) => t.segments).filter((s: any) => s.groupId).map((s: any) => s.targetStartUs)).toEqual([16000000,16000000,16000000]);
    expect(delivered.markers[0].timeUs).toBe(16000000);
  });

  it("delivers inactive A while B is selected without ever mounting RTC watcher", async () => {
    const q = await queue(); q.resumePendingGenerations(); complete();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0));
    expect(currentSeg()).toMatchObject({ kind: "media", uri: url, resultTaskRef: "gen-1", targetStartUs: 4000000, targetDurationUs: 12000000, sourceDurationUs: 12000000 });
    expect(h.state.rtcDocs["episode-B"].tracks[0].segments[0].kind).toBe("placeholder");
    expect(Object.values(h.disk.assets)).toEqual([expect.objectContaining({ episodeId: "episode-A", kind: "video", uri: url, origin: "generated" })]);
    expect(h.run).not.toHaveBeenCalled(); expect(h.freeResume).toHaveBeenCalled();
  });
  it("legacy targetless taskRef is bound across all docs and retains exact completion after switching project", async () => {
    h.state.pendingGens = [pending("gen-1", false)]; const q = await queue(); q.resumePendingGenerations();
    const original = snapshot(); setup({ pendingGens: [], rtcDocs: {} }, "project-B"); h.state.savePath = "B.Qiji";
    complete(); await wait(); expect(h.state.setRtcEpisodeDoc).not.toHaveBeenCalled();
    vi.resetModules(); setup(original, "project-A-reopen"); (await queue()).resumePendingGenerations();
    await vi.waitFor(() => expect(currentSeg()?.uri).toBe(url)); expect(h.run).not.toHaveBeenCalled(); expect(h.track).toHaveBeenCalledOnce();
  });
  it("keeps pending throughout asynchronous duration probe and ignores synchronous replay notifications", async () => {
    const duration = deferred<number>(); h.probe.mockReturnValueOnce(duration.promise);
    const q = await queue(); h.onChange = () => q.resumeRtcPendingResults(); q.resumePendingGenerations(); complete();
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce());
    expect(h.state.pendingGens[0].rtcResult.uri).toBe(url); expect(currentSeg().kind).toBe("placeholder");
    duration.resolve(7); await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0));
    expect(currentSeg().sourceDurationUs).toBe(7000000); expect(h.download).toHaveBeenCalledOnce();
  });
  it("raw-result checkpoint failure survives restart from old pending plus independent receipt", async () => {
    const q = await queue(); q.resumePendingGenerations(); const oldDisk = snapshot();
    h.saveImpl = async () => { throw new Error("disk-full"); }; complete();
    await vi.waitFor(() => expect(h.saved.size).toBeGreaterThan(0)); await wait(); expect(currentSeg().kind).toBe("placeholder");
    vi.resetModules(); h.saveImpl = undefined; setup(oldDisk, "project-A-reopen"); (await queue()).resumePendingGenerations();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0)); expect(currentSeg().uri).toBe(url);
    expect(h.track).toHaveBeenCalledOnce(); expect(h.run).not.toHaveBeenCalled(); expect(h.saved.size).toBe(0);
  });
  it("landed result and old pending replay after pending-removal save failed, without duplicate history", async () => {
    const q = await queue(); q.resumePendingGenerations();
    h.saveImpl = async () => { if (!h.state.pendingGens.length) { h.state.isDirty = true; return; } h.disk = snapshot(); h.state.isDirty = false; };
    complete(); await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0)); await wait();
    expect(h.disk.pendingGens).toHaveLength(1); expect(h.disk.rtcDocs["episode-A"].tracks[0].segments[0].kind).toBe("media"); expect(h.saved.size).toBeGreaterThan(0);
    vi.resetModules(); h.saveImpl = undefined; setup(h.disk, "project-A-reopen"); (await queue()).resumePendingGenerations();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0));
    expect(h.state.episodes[0].shots[0].videoUris).toEqual([url]); expect(h.probe).toHaveBeenCalledOnce(); expect(h.saved.size).toBe(0);
    expect(Object.keys(h.disk.assets)).toHaveLength(1); expect(h.library.addAsset).not.toHaveBeenCalled();
  });
  it("different task results completing out of order cannot take the latest shot history", async () => {
    h.state.pendingGens.push(pending("gen-2")); h.state.rtcDocs["episode-A"] = doc([seg(), seg("seg-2", "gen-2")]);
    const q = await queue(); q.resumePendingGenerations(); complete("task-gen-2", "https://fixture.invalid/two.mp4"); complete();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0));
    expect(currentSeg().uri).toBe(url); expect(currentSeg("seg-2").uri).toBe("https://fixture.invalid/two.mp4");
  });
  it.each(["video", "storyboard"])("preserves %s in the original episode library after deleting its placement", async field => {
    h.state.pendingGens[0].shot.field = field;
    const q = await queue(); q.resumePendingGenerations(); h.state.rtcDocs["episode-A"] = doc([]); complete();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0)); expect(currentSeg()).toBeUndefined(); expect(h.saved.size).toBe(0);
    expect(Object.values(h.disk.assets)).toEqual([expect.objectContaining({ episodeId: "episode-A", kind: field === "video" ? "video" : "image", uri: url })]);
    expect(h.disk.rtcDocs["episode-A"].tracks[0].segments).toEqual([]);
  });
  it("storyboard without a timeline target retains its result through a library-save failure and restart", async () => {
    h.state.pendingGens = [{ ...pending("gen-1", false), shot: { episodeId: "episode-A", shotId: "shot-1", field: "storyboard" } }];
    h.state.rtcDocs["episode-A"] = doc([]);
    const q = await queue(); q.resumePendingGenerations();
    h.saveImpl = async () => {
      if (Object.keys(h.library.assets).length) { h.state.isDirty = true; return; }
      h.disk = snapshot(); h.state.isDirty = false;
    };
    complete("task-gen-1", "https://fixture.invalid/storyboard.png");
    await vi.waitFor(() => expect(Object.keys(h.library.assets)).toHaveLength(1)); await wait();
    expect(h.state.pendingGens).toHaveLength(1); expect(h.saved.size).toBeGreaterThan(0);
    expect(h.disk.pendingGens[0].rtcResult.uri).toBe("https://fixture.invalid/storyboard.png");
    expect(h.disk.pendingGens[0].rtcTarget).toBeUndefined();
    vi.resetModules(); h.saveImpl = undefined; setup(h.disk, "project-A-reopen"); (await queue()).resumePendingGenerations();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0));
    expect(Object.values(h.disk.assets)).toEqual([expect.objectContaining({ kind: "image", episodeId: "episode-A", uri: "https://fixture.invalid/storyboard.png" })]);
    expect(h.disk.rtcDocs["episode-A"].tracks[0].segments).toEqual([]);
    expect(h.track).toHaveBeenCalledOnce(); expect(h.run).not.toHaveBeenCalled(); expect(h.saved.size).toBe(0);
  });
  it("targetless storyboard completion received in another project replays only into its original library", async () => {
    h.state.pendingGens = [{ ...pending("gen-1", false), shot: { episodeId: "episode-A", shotId: "shot-1", field: "storyboard" } }];
    h.state.rtcDocs["episode-A"] = doc([]);
    const q = await queue(); q.resumePendingGenerations(); const original = snapshot();
    setup({ pendingGens: [] }, "project-B"); h.state.savePath = "B.Qiji";
    complete("task-gen-1", "https://fixture.invalid/storyboard.png"); await wait();
    expect(h.library.assets).toEqual({}); expect(h.state.updateShot).not.toHaveBeenCalled();
    expect(h.saved.size).toBeGreaterThan(0);
    vi.resetModules(); setup(original, "project-A-reopen"); (await queue()).resumePendingGenerations();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0));
    expect(Object.values(h.disk.assets)).toEqual([expect.objectContaining({ kind: "image", episodeId: "episode-A", uri: "https://fixture.invalid/storyboard.png" })]);
    expect(h.disk.rtcDocs["episode-A"].tracks[0].segments).toEqual([]);
    expect(h.track).toHaveBeenCalledOnce(); expect(h.run).not.toHaveBeenCalled(); expect(h.saved.size).toBe(0);
  });
  it("a deleted shot and placement still leave the accepted result in the original library", async () => {
    const q = await queue(); q.resumePendingGenerations();
    h.state.episodes[0].shots = []; h.state.rtcDocs["episode-A"] = doc([]); complete();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0));
    expect(h.disk.episodes[0].shots).toEqual([]); expect(h.disk.rtcDocs["episode-A"].tracks[0].segments).toEqual([]);
    expect(Object.values(h.disk.assets)).toEqual([expect.objectContaining({ kind: "video", episodeId: "episode-A", uri: url })]);
  });
  it("project switch during duration probe cannot write matching segId in the new project", async () => {
    const duration = deferred<number>(); h.probe.mockReturnValueOnce(duration.promise); const q = await queue(); q.resumePendingGenerations(); complete();
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledOnce()); const original = snapshot();
    setup(undefined, "project-B"); h.state.savePath = "B.Qiji"; duration.resolve(7); await wait(); expect(currentSeg().kind).toBe("placeholder");
    expect(h.library.assets).toEqual({});
    vi.resetModules(); setup(original, "project-A-reopen"); (await queue()).resumePendingGenerations();
    await vi.waitFor(() => expect(currentSeg().uri).toBe(url)); expect(h.track).toHaveBeenCalledOnce();
  });
  it("non-writer completes pending without blocking the next generation but retains receipt", async () => {
    h.writer = false; const q = await queue(); q.resumePendingGenerations(); complete();
    await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0)); await wait();
    expect(currentSeg().kind).toBe("media"); expect(h.saved.size).toBeGreaterThan(0);
  });
  it.each(["delete-segment", "delete-shot", "replace-task"])("rechecks %s during pre-submit save without making a paid request", async action => {
    h.state.pendingGens = []; h.state.rtcDocs["episode-A"] = doc([{ ...seg(), taskRef: undefined, status: "pending" }]);
    const gate = deferred<void>(); let saves = 0; h.saveImpl = async () => { saves++; if (saves >= 2) await gate.promise; };
    const q = await queue(); q.startShotGeneration({ rtcTarget: target, episodeId: "episode-A", shotId: "shot-1", field: "video", purpose: "video.generation" as any, prompt: "p", label: "s" });
    await vi.waitFor(() => expect(saves).toBe(2));
    if (action === "delete-segment") h.state.rtcDocs["episode-A"] = doc([]);
    if (action === "delete-shot") h.state.episodes[0].shots = [];
    if (action === "replace-task") currentSeg().taskRef = "newer-task";
    gate.resolve(); await vi.waitFor(() => expect(h.state.pendingGens).toHaveLength(0)); expect(h.run).not.toHaveBeenCalled();
  });
  it("stale sink callbacks do not clear queue state belonging to another owner/task", async () => {
    const sink = await import("@/rtc/panel/rtcGenSink");
    sink.armRunning("seg-1", "old", "old-project", { target });
    sink.markFailed("seg-1", "late", "project-A", { target, expectedTaskRef: "old" });
    sink.landMedia("seg-1", { uri: url, media: "video", owner: "project-A", target, expectedTaskRef: "old" });
    sink.mirrorProgress("seg-1", 50, "project-A", {}, { target, expectedTaskRef: "old" });
    expect(h.queueInfo).not.toHaveBeenCalled(); expect(currentSeg().kind).toBe("placeholder");
  });
});
