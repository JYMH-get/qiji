import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InferTask, StoryboardShot } from "./projectFile";
import type { RtcDoc, RtcSegment } from "@/types/rtc";

const h = vi.hoisted(() => ({ project: {} as any, rtc: {} as any, run: vi.fn(), track: vi.fn(), resolve: undefined as any, reject: undefined as any, listeners: new Set<(state: any) => void>() }));
vi.mock("./purposeRunner", () => ({ runPurpose: h.run }));
vi.mock("./taskCenter", () => ({ trackTask: h.track }));
vi.mock("./generationQueue", () => ({ setJobProgress: vi.fn(), clearJobProgress: vi.fn() }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.project,
  subscribe: (listener: (state: any) => void) => { h.listeners.add(listener); return () => h.listeners.delete(listener); },
} }));
vi.mock("@/store/rtcStore", () => ({ useRtcStore: { getState: () => h.rtc } }));
vi.mock("@/store/connectionStore", () => ({ getDualModeFeature: () => true }));
import { resumeInferTasks, startInfer } from "./inferRun";

const SEC = 1_000_000;
const shot = (id: string, index: number): StoryboardShot => ({ id, index, title: `分镜${index}`, prompt: "", materials: [] });
const segment = (id: string, shotId?: string, start = 0): RtcSegment => ({ id, kind: "media", media: "video", uri: "local://existing.mp4", targetStartUs: start, targetDurationUs: 5 * SEC, ...(shotId ? { shotRef: { episodeId: "a", shotId } } : {}) });
const doc = (segments: RtcSegment[] = []): RtcDoc => ({ id: "doc-a", fps: 30, name: "A", tracks: [{ id: "main", type: "video", segments }] });
const cards = (durations: Array<number | undefined>) => JSON.stringify(durations.map((duration, i) => ({ card_number: i + 1, original_script: `第${i + 1}段足够长的剧本原文`, ...(duration == null ? {} : { duration }), video_prompts: `第${i + 1}镜提示词` })));
const start = (extra: any = {}) => startInfer({ episodeId: "a", mode: "multi", templateId: "template", variables: { 原文: "原文" }, rtcAutoPlaceholders: true, ...extra });
const input = () => h.run.mock.calls[h.run.mock.calls.length - 1][1];
const resumed = () => h.track.mock.calls[h.track.mock.calls.length - 1][0].onUpdate;
const progress = (text: string) => input().onProgress(10, "running", text);
const segments = () => h.project.rtcDocs.a.tracks[0].segments as RtcSegment[];
const restore = (snapshot: any) => { h.project = { ...h.project, ...JSON.parse(JSON.stringify(snapshot)) }; h.rtc = { ...h.rtc, ownerProjectId: h.project.projectInstanceId, doc: h.project.rtcDocs.a }; };
const stateChange = (patch: Record<string, unknown>) => { Object.assign(h.project, patch); for (const listener of h.listeners) listener(h.project); };

beforeEach(() => {
  h.listeners.clear();
  h.run.mockReset().mockImplementation(() => new Promise((resolve, reject) => { h.resolve = resolve; h.reject = reject; })); h.track.mockReset();
  h.project = {
    projectInstanceId: "owner-a", rtcEpisodeId: "a", isProjectLoading: false,
    episodes: [{ id: "a", index: 1, shots: [] }, { id: "b", index: 2, shots: [] }], inferTasks: [], rtcDocs: { a: doc() },
    save: vi.fn(async () => {}), blobByUri: () => undefined,
    addInferTask: (task: InferTask) => { h.project.inferTasks = [...h.project.inferTasks, task]; },
    updateInferTask: (id: string, patch: Partial<InferTask>) => { h.project.inferTasks = h.project.inferTasks.map((t: InferTask) => t.id === id ? { ...t, ...patch } : t); },
    removeInferTask: (id: string) => { h.project.inferTasks = h.project.inferTasks.filter((t: InferTask) => t.id !== id); },
    setEpisodeShots: (epId: string, shots: StoryboardShot[]) => { h.project.episodes = h.project.episodes.map((ep: any) => ep.id === epId ? { ...ep, shots } : ep); },
    updateShot: (epId: string, id: string, patch: Partial<StoryboardShot>) => { const ep = h.project.episodes.find((e: any) => e.id === epId); ep.shots = ep.shots.map((s: StoryboardShot) => s.id === id ? { ...s, ...patch } : s); },
    setRtcEpisodeDoc: vi.fn((epId: string, next: RtcDoc) => { h.project.rtcDocs = { ...h.project.rtcDocs, [epId]: next }; }),
  };
  h.rtc = { doc: h.project.rtcDocs.a, ownerProjectId: "owner-a", ownerEpisodeKey: "a", past: [],
    commit: vi.fn((mutate: (d: RtcDoc) => RtcDoc) => { const previous = h.rtc.doc; h.rtc.doc = mutate(previous); h.rtc.past.push(previous); h.project.setRtcEpisodeDoc("a", h.rtc.doc); }) };
});

describe("RTC 整集流式推理占位", () => {
  it("仅显式 RTC 整集启用，表格/单镜均不追加", async () => {
    start({ rtcAutoPlaceholders: undefined }); progress(cards([8]));
    expect(segments()).toHaveLength(0); expect(h.project.inferTasks[0].rtcPlacement).toBeUndefined();
    start({ mode: "single", shotId: h.project.episodes[0].shots[0].id }); progress(cards([8]));
    expect(segments()).toHaveLength(0); expect(h.project.inferTasks.at(-1).rtcPlacement).toBeUndefined();
  });

  it("未闭合卡先更新文字，等真实时长完整后立即占位，避免默认15秒或首位数字", () => {
    start();
    const prefix = '[{"card_number":1,"original_script":"第一段足够长的剧本原文，等待时长。",';
    progress(prefix); expect(h.project.episodes[0].shots).toHaveLength(1); expect(segments()).toHaveLength(0);
    expect(h.project.episodes[0].shots[0].durationSec).toBeUndefined();
    progress(prefix + '"duration":1'); expect(segments()).toHaveLength(0);
    progress(prefix + '"duration":12,"video_prompts":"提示词仍在流式输出');
    expect(segments()).toHaveLength(1); expect(segments()[0].targetDurationUs).toBe(12 * SEC);
    expect(h.project.episodes[0].shots[0].durationSec).toBe(12);
  });

  it("正文内的括号和转义引号不让缺时长卡提前入轨，闭卡后按15秒", () => {
    start();
    progress('[{"card_number":1,"original_script":"这段正文里有 } 和 \\\"引用\\\"，但卡片仍未结束');
    expect(segments()).toHaveLength(0);
    progress(cards([undefined])); expect(segments()[0].targetDurationUs).toBe(15 * SEC);
  });

  it("卡片内附加对象闭合不冒充整卡闭合", () => {
    start();
    const text = '[{"card_number":1,"original_script":"第一段足够长的原文", "camera":{"x":1},';
    progress(text); expect(segments()).toHaveLength(0);
    progress(text + '"duration":8,"video_prompts":"开始输出');
    expect(segments()[0].targetDurationUs).toBe(8 * SEC);
  });

  it.each([0, -3])("非法duration=%s不能变成其它正秒数", async duration => {
    start(); h.resolve({ status: "success", resultUri: cards([duration]) }); await Promise.resolve();
    expect(segments()[0].targetDurationUs).toBe(15 * SEC);
  });

  it("最终容错结果缺时长仍按15秒入轨", async () => {
    start(); h.resolve({ status: "success", resultUri: '{"card_number":1,"original_script":"最终原文没有闭合' });
    await Promise.resolve();
    expect(segments()[0].targetDurationUs).toBe(15 * SEC); expect(h.project.inferTasks).toHaveLength(0);
  });

  it.each([false, true])("旧分镜不掩盖本次零产出（重启找回=%s）", async resume => {
    h.project.episodes[0].shots = [shot("existing", 1)];
    start();
    if (resume) {
      input().onTaskId("server-task", "adapter"); resumeInferTasks();
      resumed()(100, "success", "未解析到卡片");
    } else {
      h.resolve({ status: "success", resultUri: "未解析到卡片" }); await Promise.resolve();
    }
    expect(h.project.inferTasks[0]).toMatchObject({ status: "failed", error: expect.stringContaining("未能从模型输出解析出结果") });
    expect(segments()).toHaveLength(0); expect(h.project.episodes[0].shots[0].id).toBe("existing");
  });

  it.each(["multi", "split"])("%s保留原片段和老镜ID，仅本次已产出镜头入轨，不拉入老尾镜", mode => {
    h.project.episodes[0].shots = [shot("old-1", 1), shot("old-2", 2), shot("unprocessed-3", 3)];
    const old = segment("existing", undefined, 7 * SEC); h.rtc.doc = h.project.rtcDocs.a = doc([old]);
    start({ mode }); progress(cards([8]));
    expect(segments()[0]).toBe(old); expect(segments()).toHaveLength(2);
    expect(segments()[1]).toMatchObject({ kind: "placeholder", shotRef: { episodeId: "a", shotId: "old-1" }, targetStartUs: 12 * SEC, targetDurationUs: 8 * SEC });
    expect(h.project.episodes[0].shots.map((s: any) => s.id)).toEqual(["old-1", "old-2", "unprocessed-3"]);
    expect(h.project.inferTasks[0].rtcPlacement.handledShotIds).toEqual(["old-1"]);
  });

  it("同镜后续流和最终回包不重复commit或改占位几何；新镜形成新的可撤销批次", async () => {
    start(); progress(cards([8])); const first = segments()[0];
    progress(cards([11])); expect(segments()[0]).toBe(first); expect(h.rtc.commit).toHaveBeenCalledTimes(1);
    progress(cards([11, 6])); expect(segments()[1].targetStartUs).toBe(8 * SEC); expect(h.rtc.commit).toHaveBeenCalledTimes(2);
    h.resolve({ status: "success", resultUri: cards([11, 6]) }); await Promise.resolve();
    expect(segments()).toHaveLength(2); expect(h.rtc.commit).toHaveBeenCalledTimes(2);
  });

  it("分割及复合内已有引用都跳过，保留用户剪辑", () => {
    h.project.episodes[0].shots = [shot("s1", 1), shot("s2", 2), shot("s3", 3)];
    const base = doc([segment("s1-left", "s1"), segment("s1-right", "s1", 5 * SEC)]);
    base.subDocs = { child: { id: "child", name: "复合", tracks: [{ id: "child-video", type: "video", segments: [segment("child-s2", "s2")] }] } };
    h.rtc.doc = h.project.rtcDocs.a = base;
    start(); progress(cards([8, 8, 8]));
    expect(segments().map(s => s.id).slice(0, 2)).toEqual(["s1-left", "s1-right"]);
    expect(segments().filter(s => s.shotRef?.shotId === "s2")).toHaveLength(0);
    expect(segments()[segments().length - 1].shotRef?.shotId).toBe("s3"); expect(h.rtc.doc.subDocs.child).toBe(base.subDocs.child);
  });

  it("删除或撤销入轨后同镜chunk不复活，持久任务恢复也保留删除", () => {
    const id = start(); input().onTaskId("server-task", "adapter"); progress(cards([8]));
    h.rtc.doc = h.project.rtcDocs.a = h.rtc.past[0]; // 模拟Ctrl+Z回到新占位前文档
    progress(cards([8])); expect(segments()).toHaveLength(0);
    const snapshot = JSON.parse(JSON.stringify(h.project)); snapshot.projectInstanceId = "reopened"; restore(snapshot);
    resumeInferTasks(); resumed()(50, "running", undefined, undefined, undefined, cards([8, 6]));
    expect(segments()).toHaveLength(1); expect(segments()[0].shotRef?.shotId).not.toBe(h.project.inferTasks.find((t: InferTask) => t.id === id).rtcPlacement.handledShotIds[0]);
  });

  it("切分集仍写原集，不切回；原集无文档可在后台新建", () => {
    start(); delete h.project.rtcDocs.a;
    h.project.rtcEpisodeId = "b"; h.rtc.ownerEpisodeKey = "b"; h.rtc.doc = doc([segment("b-existing")]);
    const bDoc = h.rtc.doc; progress(cards([8]));
    expect(h.project.rtcEpisodeId).toBe("b"); expect(h.rtc.doc).toBe(bDoc); expect(h.rtc.commit).not.toHaveBeenCalled();
    expect(segments()).toHaveLength(1); expect(segments()[0].shotRef?.episodeId).toBe("a");
  });

  it("编辑复合子层时追加到本集主层，不改变子层片段或编辑上下文", () => {
    const root = doc([{ id: "compound", kind: "compound", subDocId: "child", targetStartUs: 0, targetDurationUs: 5 * SEC }]);
    const child = { id: "child", name: "child", tracks: [{ id: "child-track", type: "video" as const, segments: [segment("child-existing")] }] };
    root.subDocs = { child }; h.rtc.doc = h.project.rtcDocs.a = root; h.rtc.editingSubDocId = "child";
    start(); progress(cards([8]));
    expect(h.rtc.editingSubDocId).toBe("child"); expect(h.rtc.doc.subDocs.child).toBe(child);
    expect(segments()).toHaveLength(2); expect(segments()[1]).toMatchObject({ kind: "placeholder", targetStartUs: 5 * SEC });
  });

  it("重新推理只更新文本/时长，保留分镜所有已有产物、历史、素材与模型覆盖", async () => {
    const original = { ...shot("original", 1), storyboardUri: "image-result", videoUri: "video-result", images: ["old-image"], videos: ["old-video"],
      materials: [{ id: "material", uri: "reference" }], derived: [{ id: "derived-result" }], overrides: { duration: 20, videoModelKey: "explicit-model" } };
    h.project.episodes[0].shots = [original];
    const oldSegment = segment("edited-result", "original", 4 * SEC); h.rtc.doc = h.project.rtcDocs.a = doc([oldSegment]);
    start(); progress(cards([8])); h.resolve({ status: "success", resultUri: cards([8]) }); await Promise.resolve();
    const updated = h.project.episodes[0].shots[0];
    expect(updated).toMatchObject({ id: "original", storyboardUri: "image-result", videoUri: "video-result", images: ["old-image"], videos: ["old-video"],
      materials: original.materials, derived: original.derived, overrides: original.overrides, durationSec: 8 });
    expect(segments()).toEqual([oldSegment]); expect(segments()[0]).toBe(oldSegment);
  });

  it.each(["project", "episode-deleted", "task-replaced", "loading"])("%s 后迟到的受理/进度/完成都不写新状态", async reason => {
    start(); const callbacks = input();
    if (reason === "project") h.project.projectInstanceId = "copy-with-same-task-ids";
    if (reason === "episode-deleted") h.project.episodes = [];
    if (reason === "task-replaced") h.project.inferTasks = [];
    if (reason === "loading") h.project.isProjectLoading = true;
    const before = JSON.stringify(h.project); const saves = h.project.save.mock.calls.length;
    callbacks.onTaskId("late-task", "adapter"); callbacks.onProgress(80, "running", cards([8]));
    h.resolve({ status: "success", resultUri: cards([8]) }); await Promise.resolve();
    expect(JSON.stringify(h.project)).toBe(before); expect(h.project.save).toHaveBeenCalledTimes(saves);
  });

  it("重启找回依任务opt-in恢复流式占位；已编辑文本保留，回调再次切项目后失效", () => {
    start(); input().onTaskId("server-task", "adapter");
    progress('[{"card_number":1,"original_script":"尚未收到时长的原文内容，先保存到项目",');
    h.project.episodes[0].shots[0].scriptSegment = "人工保留原文";
    const snapshot = JSON.parse(JSON.stringify(h.project)); snapshot.projectInstanceId = "reopened"; restore(snapshot);
    resumeInferTasks(); const onUpdate = resumed();
    onUpdate(30, "running", undefined, undefined, undefined, cards([8]));
    expect(segments()[0].targetDurationUs).toBe(8 * SEC); expect(h.project.episodes[0].shots[0].scriptSegment).toBe("人工保留原文");
    h.project.projectInstanceId = "new-project"; const before = JSON.stringify(h.project);
    onUpdate(100, "success", cards([8, 6])); expect(JSON.stringify(h.project)).toBe(before);
  });

  it.each([
    [false, "success"], [false, "failed"], [false, "exception"],
    [true, "success"], [true, "failed"], [true, "lost"],
  ] as const)("加载失败回原项目后保留终态，resume=%s status=%s", async (resume, status) => {
    start(); input().onTaskId("accepted", "adapter");
    if (resume) resumeInferTasks();
    stateChange({ isProjectLoading: true });
    if (resume) resumed()(100, status, status === "success" ? cards([8]) : undefined, "上游失败");
    else if (status === "exception") h.reject(new Error("上游失败"));
    else h.resolve({ status, resultUri: status === "success" ? cards([8]) : undefined, error: "上游失败" });
    await Promise.resolve(); await Promise.resolve();
    expect(h.listeners.size).toBe(1); expect(segments()).toHaveLength(0); expect(h.project.inferTasks[0].status).toBe("running");
    stateChange({ isProjectLoading: false });
    expect(h.listeners.size).toBe(0);
    if (status === "success") { expect(segments()).toHaveLength(1); expect(h.project.inferTasks).toHaveLength(0); }
    else { expect(h.project.inferTasks[0]).toMatchObject({ status: "failed", error: "上游失败" }); expect(segments()).toHaveLength(0); }
  });

  it.each([false, true])("等待终态期间换项目则弃旧结果并解除订阅，resume=%s", async resume => {
    start(); input().onTaskId("accepted", "adapter"); if (resume) resumeInferTasks();
    stateChange({ isProjectLoading: true });
    if (resume) resumed()(100, "success", cards([8])); else h.resolve({ status: "success", resultUri: cards([8]) });
    await Promise.resolve(); expect(h.listeners.size).toBe(1);
    stateChange({ projectInstanceId: "another-owner" }); expect(h.listeners.size).toBe(0);
    stateChange({ isProjectLoading: false }); expect(segments()).toHaveLength(0); expect(h.project.episodes[0].shots).toHaveLength(0);
  });

  it("等待期间任务被删除立即解除订阅，加载结束不复活", async () => {
    start(); stateChange({ isProjectLoading: true }); h.resolve({ status: "success", resultUri: cards([8]) }); await Promise.resolve();
    expect(h.listeners.size).toBe(1); stateChange({ inferTasks: [] }); expect(h.listeners.size).toBe(0);
    stateChange({ isProjectLoading: false }); expect(segments()).toHaveLength(0);
  });
});
