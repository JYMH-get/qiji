import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StartInferSpec } from "@/services/inferRun";

const h = vi.hoisted(() => ({ project: {} as any, templates: [] as any[], model: "text-original", dual: true, start: vi.fn(), confirm: vi.fn() }));
vi.mock("@/store/projectStore", () => ({ useProjectStore: { getState: () => h.project } }));
vi.mock("@/store/catalogStore", () => ({ useCatalogStore: { getState: () => ({ catalog: { templates: h.templates } }) } }));
vi.mock("@/store/connectionStore", () => ({ getDualModeFeature: () => h.dual }));
vi.mock("@/components/ModelPicker", () => ({ effectiveModelKey: () => h.model }));
vi.mock("@/lib/confirmDialog", () => ({ confirmDialog: h.confirm }));
vi.mock("@/services/inferRun", () => ({ startInfer: h.start }));
import { episodeInferLocked, smartInferEpisode, smartSplitEpisode } from "./rtcEpisodeInferenceActions";

const defer = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const request = () => h.start.mock.calls[0][0] as StartInferSpec;
beforeEach(() => {
  h.project = {
    projectInstanceId: "project-a", isProjectLoading: false, rtcEpisodeId: "ep",
    episodes: [{ id: "ep", scriptText: "完整原文，保持原始换行\n第二行", shots: [{ id: "shot-1", index: 1, title: "分镜1", storyboardUri: "saved-image", videoUri: "saved-video", materials: [{ id: "ref" }] }] }],
    mediaSettings: { maxDuration: 30, imgVideoSameSource: false, inferenceStrategy: { templateId: "creative", guidance: "项目引导" }, splitTplId: "split-old" },
    visualStyle: "原画风", characters: [{ id: "C01-test", name: "原角色" }], inferTasks: [], setEpisodeShots: vi.fn(),
  };
  h.templates = [
    { id: "creative", aliases: ["creative-old"], name: "创作方案", purpose: "storyboard.singleShot", isDefault: true },
    { id: "unified-creative", purpose: "storyboard.unified" },
    { id: "split-real", aliases: ["split-old"], purpose: "storyboard.split", isDefault: true },
    { id: "output.storyboard.toVideoPrompt", purpose: "storyboard.toVideoPrompt", category: "输出提示词" },
    { id: "output.storyboard.unified", purpose: "storyboard.unified", category: "输出提示词" },
  ];
  h.model = "text-original"; h.dual = true;
  h.confirm.mockReset().mockResolvedValue(true);
  h.start.mockReset().mockImplementation((spec: StartInferSpec) => {
    h.project.inferTasks.push({ id: "task", episodeId: spec.episodeId, mode: spec.mode, status: "running" });
    return "task";
  });
});

describe("RTC 整集推理动作", () => {
  it("解析方案别名，固定整集输出，保留旧镜ID/成品/素材并启用流式占位", async () => {
    h.project.mediaSettings.inferenceStrategy.templateId = "creative-old";
    const shots = h.project.episodes[0].shots;
    expect(await smartInferEpisode("ep")).toEqual({ ok: true, message: "" });
    expect(request()).toMatchObject({ episodeId: "ep", mode: "multi", sameSource: false, templateId: "creative", rtcAutoPlaceholders: true,
      inference: { source: "template", guidance: "项目引导", durationRange: { min: 4, max: 30 }, durationLimit: 30 }, modelKey: "text-original" });
    expect(h.project.episodes[0].shots).toBe(shots); expect(shots[0].videoUri).toBe("saved-video");
    expect(h.project.setEpisodeShots).not.toHaveBeenCalled(); expect(h.confirm).toHaveBeenCalledWith(expect.stringContaining("保留已有成片和剪辑"));
    expect(episodeInferLocked("ep")).toBe(true);
  });

  it("确认前冻结Skills正文、名称、引导、原文、画风、资产列表与模型", async () => {
    const confirmation = defer<boolean>(); h.confirm.mockReturnValue(confirmation.promise);
    h.project.mediaSettings.inferenceStrategy = { source: "skill", skillText: "自有 Skills {{字面变量}}", skillName: "我的方案", guidance: "原引导" };
    const result = smartInferEpisode("ep");
    h.project.mediaSettings.inferenceStrategy.skillText = "后改正文"; h.project.mediaSettings.inferenceStrategy.guidance = "后改引导";
    h.project.mediaSettings.maxDuration = 15; h.project.mediaSettings.imgVideoSameSource = true;
    h.project.episodes[0].scriptText = "后改原文"; h.project.visualStyle = "后改画风"; h.project.characters[0].name = "后改角色"; h.model = "text-changed";
    confirmation.resolve(true); expect(await result).toEqual({ ok: true, message: "" });
    expect(request()).toMatchObject({ templateId: "", sameSource: false, modelKey: "text-original", inference: { source: "skill", skillText: "自有 Skills {{字面变量}}", skillName: "我的方案", guidance: "原引导", durationLimit: 30 },
      variables: { 原文: "完整原文，保持原始换行\n第二行", 视觉风格: "原画风", 角色列表: "C01 原角色" } });
  });

  it("未开放双模时同源，旧项目拆分引用不当成推理方案", async () => {
    h.dual = false; delete h.project.mediaSettings.inferenceStrategy; h.project.mediaSettings.inferTplId = "split-old";
    await smartInferEpisode("ep");
    expect(request()).toMatchObject({ sameSource: true, templateId: "creative", mode: "multi" });
  });

  it.each(["missing-template", "empty-skill"])("%s在确认前明确拒绝且释放准备锁", async kind => {
    h.project.mediaSettings.inferenceStrategy = kind === "missing-template" ? { templateId: "not-in-catalog" } : { source: "skill", skillText: " " };
    const result = await smartInferEpisode("ep"); expect(result.ok).toBe(false); expect(result.message).not.toBe("");
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled(); expect(episodeInferLocked("ep")).toBe(false);
    h.project.mediaSettings.inferenceStrategy = { templateId: "creative" };
    expect((await smartInferEpisode("ep")).ok).toBe(true);
  });

  it("推理与拆分共用确认前准备锁，连点只弹一次且仅提交一次", async () => {
    const confirmation = defer<boolean>(); h.confirm.mockReturnValue(confirmation.promise);
    const first = smartInferEpisode("ep"); expect(episodeInferLocked("ep")).toBe(true);
    expect(await smartInferEpisode("ep")).toEqual({ ok: false, message: "" });
    expect(await smartSplitEpisode("ep")).toEqual({ ok: false, message: "" });
    expect(h.confirm).toHaveBeenCalledTimes(1);
    confirmation.resolve(true); await first; expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("取消确认不清分镜且释放准备锁", async () => {
    h.confirm.mockResolvedValueOnce(false); const before = h.project.episodes[0].shots;
    expect(await smartSplitEpisode("ep")).toEqual({ ok: false, message: "" }); expect(episodeInferLocked("ep")).toBe(false);
    expect(h.project.episodes[0].shots).toBe(before); expect(h.start).not.toHaveBeenCalled();
    expect((await smartInferEpisode("ep")).ok).toBe(true);
  });

  it.each(["project", "loading", "deleted"])("确认期间%s变化后静默取消，不修改新状态", async change => {
    const confirmation = defer<boolean>(); h.confirm.mockReturnValue(confirmation.promise); const result = smartInferEpisode("ep");
    if (change === "project") h.project.projectInstanceId = "project-copy";
    if (change === "loading") h.project.isProjectLoading = true;
    if (change === "deleted") h.project.episodes = [];
    confirmation.resolve(true);
    expect(await result).toEqual({ ok: false, message: "" }); expect(h.start).not.toHaveBeenCalled(); expect(h.project.setEpisodeShots).not.toHaveBeenCalled();
  });

  it("同项目切到另一集不改变冻结的原集请求", async () => {
    const confirmation = defer<boolean>(); h.confirm.mockReturnValue(confirmation.promise); const result = smartInferEpisode("ep");
    h.project.rtcEpisodeId = "another-episode"; confirmation.resolve(true); await result;
    expect(request().episodeId).toBe("ep"); expect(h.project.rtcEpisodeId).toBe("another-episode");
  });

  it("动态加载await期间切项目仍取消（空集无需确认）", async () => {
    h.project.episodes[0].shots = []; const result = smartInferEpisode("ep"); h.project.projectInstanceId = "new-project";
    expect(await result).toEqual({ ok: false, message: "" }); expect(h.confirm).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
  });

  it("确认期间有其它入口登记同集任务时不再提交", async () => {
    const confirmation = defer<boolean>(); h.confirm.mockReturnValue(confirmation.promise); const result = smartInferEpisode("ep");
    h.project.inferTasks.push({ id: "other", episodeId: "ep", mode: "split", status: "running" });
    confirmation.resolve(true); expect(await result).toEqual({ ok: false, message: "" }); expect(h.start).not.toHaveBeenCalled();
  });

  it("旧项目准备结束不释放新项目相同集ID的锁，旧错误不出现在新项目", async () => {
    const firstConfirm = defer<boolean>(), secondConfirm = defer<boolean>();
    h.confirm.mockReturnValueOnce(firstConfirm.promise).mockReturnValueOnce(secondConfirm.promise);
    const first = smartInferEpisode("ep"); h.project.projectInstanceId = "new-project";
    const second = smartSplitEpisode("ep"); firstConfirm.reject(new Error("旧项目错误"));
    expect(await first).toEqual({ ok: false, message: "" }); expect(episodeInferLocked("ep")).toBe(true);
    secondConfirm.resolve(true); expect((await second).ok).toBe(true); expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("提交异常明确返回且释放准备锁，可再次受理", async () => {
    h.start.mockImplementationOnce(() => { throw new Error("加载失败"); });
    expect(await smartInferEpisode("ep")).toEqual({ ok: false, message: "加载失败" }); expect(episodeInferLocked("ep")).toBe(false);
    expect((await smartInferEpisode("ep")).ok).toBe(true);
  });
});

describe("RTC 整集拆分方案", () => {
  it.each([false, true])("解析现有拆分方案并透传原始最大时长，同源=%s", async sameSource => {
    h.project.mediaSettings.imgVideoSameSource = sameSource; h.project.mediaSettings.maxDuration = 20;
    expect((await smartSplitEpisode("ep")).ok).toBe(true);
    expect(request()).toMatchObject({ mode: "split", templateId: "split-real", sameSource, rtcAutoPlaceholders: true,
      inference: { source: "template", outputMode: sameSource ? "unified" : "storyboard", durationRange: { min: 4, max: 20 }, durationLimit: 30, guidance: "项目引导" } });
    expect(h.project.setEpisodeShots).not.toHaveBeenCalled(); expect(h.confirm).toHaveBeenCalledWith(expect.stringContaining("保留已有提示词、成片和剪辑"));
  });

  it.each(["template", "output", "duration"])("无有效%s时不提交、不清旧镜，返回可处理错误", async invalid => {
    if (invalid === "template") h.templates = h.templates.filter(t => t.purpose !== "storyboard.split");
    if (invalid === "output") h.templates = h.templates.filter(t => t.category !== "输出提示词");
    if (invalid === "duration") h.project.mediaSettings.maxDuration = 3;
    const result = await smartSplitEpisode("ep"); expect(result.ok).toBe(false); expect(result.message).not.toBe("");
    expect(h.start).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled(); expect(h.project.setEpisodeShots).not.toHaveBeenCalled();
    expect(episodeInferLocked("ep")).toBe(false);
  });
});

describe.each([
  ["multi", smartInferEpisode], ["split", smartSplitEpisode],
] as const)("RTC %s 共享时长范围", (_mode, submit) => {
  it("旧8秒上限如实提交4–8，而不变为15秒", async () => {
    h.project.mediaSettings.maxDuration = 8;
    expect((await submit("ep")).ok).toBe(true);
    expect(request().inference).toMatchObject({ durationRange: { min: 4, max: 8 }, durationLimit: 15 });
  });

  it("冻结自定义范围并透传小数/超过30秒的最大值", async () => {
    const confirmation = defer<boolean>(); h.confirm.mockReturnValue(confirmation.promise);
    Object.assign(h.project.mediaSettings, { inferenceDurationPreset: "custom", inferenceCustomDuration: { min: 1.25, max: 65.5 } });
    const result = submit("ep");
    h.project.mediaSettings.inferenceCustomDuration.min = 8;
    h.project.mediaSettings.inferenceCustomDuration.max = 12;
    h.project.mediaSettings.inferenceDurationPreset = "4-15";
    confirmation.resolve(true); expect((await result).ok).toBe(true);
    expect(request().inference).toMatchObject({ durationRange: { min: 1.25, max: 65.5 }, durationLimit: 30 });
  });

  it.each([undefined, { min: "", max: 15 }, { min: 20, max: 10 }, { min: 4, max: Infinity }])("非法自定义范围 %j 不确认/提交/清镜头，修正后可重试", async inferenceCustomDuration => {
    const shots = h.project.episodes[0].shots;
    Object.assign(h.project.mediaSettings, { maxDuration: 30, inferenceDurationPreset: "custom", inferenceCustomDuration });
    const result = await submit("ep");
    expect(result.ok).toBe(false); expect(result.message).not.toBe("");
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.start).not.toHaveBeenCalled();
    expect(h.project.episodes[0].shots).toBe(shots); expect(h.project.setEpisodeShots).not.toHaveBeenCalled();
    expect(episodeInferLocked("ep")).toBe(false);
    h.project.mediaSettings.inferenceCustomDuration = { min: 6, max: 12 };
    expect((await submit("ep")).ok).toBe(true);
    expect(request().inference).toMatchObject({ durationRange: { min: 6, max: 12 } });
  });
});
