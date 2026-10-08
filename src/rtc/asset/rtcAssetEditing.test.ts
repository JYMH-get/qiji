import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import type { PendingGen } from "@/services/projectFile";
import { useAssetFormStore } from "@/store/assetFormStore";
import { useRtcStore } from "@/store/rtcStore";
import { settleConfirm, useConfirmStore } from "@/lib/confirmDialog";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { useRtcCenterTabStore } from "../panel/rtcCenterTabStore";
import { useRtcPropsTabStore } from "../panel/rtcPropsTabStore";
import { createRtcAsset, deleteRtcAsset } from "./rtcAssetEditing";

const owner = "rtc-asset-editing-project-A";
const cats: AssetCat[] = ["characters", "crowds", "scenes", "organisms", "items"];
const originalSave = useProjectStore.getState().save;
const originalScheduleAutoSave = useProjectStore.getState().scheduleAutoSave;
const save = vi.fn(async () => {});
const scheduleAutoSave = vi.fn();
const asset = (id = "asset-a", name = "角色甲") => ({
  id, name, prompt: "角色提示词", images: ["history-a.png"], image: "history-a.png",
  variants: [{ id: "variant-a", name: "战斗造型", label: "战斗", description: "说明", images: ["variant-a.png"] }],
});
const pending = (id: string, cat: AssetCat, assetId: string, variantId: string | null = null): PendingGen => ({
  id, cat, assetId, variantId, purpose: "asset.character.image", prompt: "提示词", label: "资产",
  status: "running", createdAt: 1,
});

beforeEach(() => {
  settleConfirm(false);
  save.mockClear(); scheduleAutoSave.mockClear();
  useProjectStore.setState({
    projectInstanceId: owner, isProjectLoading: false, isDirty: false, savePath: null,
    characters: [asset(), asset("asset-b", "角色乙")] as any,
    crowds: [], scenes: [asset("asset-a", "同 ID 场景")] as any, organisms: [], items: [],
    pendingGens: [], save, scheduleAutoSave,
  });
  useAssetFormStore.setState({ selForm: { "asset-a": "variant-a", "asset-b": "variant-b" } });
  useRtcAssetSelStore.getState().clear();
  useRtcStore.getState().setSelection(["timeline-before-edit"]);
  useRtcCenterTabStore.setState({ tab: "overview", scriptEditorOpen: true, scriptEditorHidden: false });
  useRtcPropsTabStore.getState().setTab("shots");
});

afterEach(() => {
  settleConfirm(false);
  useProjectStore.setState({ save: originalSave, scheduleAutoSave: originalScheduleAutoSave });
});

describe("RTC 资产新增", () => {
  it.each(cats)("%s 新增到正确分类并打开基础形象工作台", cat => {
    const before = Object.fromEntries(cats.map(key => [key, useProjectStore.getState()[key]]));
    const id = createRtcAsset(owner, cat, "  新资产  ");
    expect(id).toMatch(new RegExp(`^${cat}-`));
    const field = cat === "characters" || cat === "crowds" ? "features" : "description";
    expect(useProjectStore.getState()[cat]).toEqual([
      ...before[cat], { id, name: "新资产", [field]: "", philosophy: "", prompt: "", images: [], variants: [] },
    ]);
    for (const other of cats.filter(key => key !== cat)) expect(useProjectStore.getState()[other]).toBe(before[other]);
    expect(useAssetFormStore.getState().selForm[id!]).toBeNull();
    expect(useRtcAssetSelStore.getState().selected).toEqual({ cat, id });
    expect(useRtcStore.getState().selection).toEqual([]);
    expect(useRtcCenterTabStore.getState()).toMatchObject({ tab: "preview", scriptEditorOpen: true, scriptEditorHidden: true });
    expect(useRtcPropsTabStore.getState().tab).toBe("props");
    expect(scheduleAutoSave).toHaveBeenCalledWith("canvas");
  });

  it.each(["", "   ", "\n\t"])("空名 %j 不写入且不改变选中", name => {
    const before = useProjectStore.getState().characters;
    useRtcAssetSelStore.getState().select({ cat: "characters", id: "asset-b" });
    expect(createRtcAsset(owner, "characters", name)).toBeNull();
    expect(useProjectStore.getState().characters).toBe(before);
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(useRtcAssetSelStore.getState().selected).toEqual({ cat: "characters", id: "asset-b" });
    expect(useRtcStore.getState().selection).toEqual(["timeline-before-edit"]);
    expect(scheduleAutoSave).not.toHaveBeenCalled();
  });

  it.each([
    { projectInstanceId: "rtc-asset-editing-project-B", isProjectLoading: false },
    { projectInstanceId: owner, isProjectLoading: true },
  ])("旧项目回调或加载期间不新增：%j", state => {
    useProjectStore.setState(state);
    const before = useProjectStore.getState().characters;
    expect(createRtcAsset(owner, "characters", "新资产")).toBeNull();
    expect(useProjectStore.getState().characters).toBe(before);
    expect(useProjectStore.getState().isDirty).toBe(false);
    expect(useRtcAssetSelStore.getState().selected).toBeNull();
    expect(useRtcCenterTabStore.getState().tab).toBe("overview");
    expect(scheduleAutoSave).not.toHaveBeenCalled();
  });
});

describe("RTC 资产删除确认与归属", () => {
  it("取消删除保留主体、分体、历史、任务和当前选中", async () => {
    const work = pending("keep-task", "characters", "asset-a", "variant-a");
    useProjectStore.setState({ pendingGens: [work] });
    useRtcAssetSelStore.getState().select({ cat: "characters", id: "asset-a" });
    const before = useProjectStore.getState().characters;
    const deleting = deleteRtcAsset(owner, "characters", "asset-a");
    expect(useConfirmStore.getState()).toMatchObject({ open: true, title: "删除资产" });
    expect(useConfirmStore.getState().message).toContain("角色甲");
    settleConfirm(false);
    expect(await deleting).toBe(false);
    expect(useProjectStore.getState().characters).toBe(before);
    expect(useProjectStore.getState().pendingGens).toEqual([work]);
    expect(useRtcAssetSelStore.getState().selected).toEqual({ cat: "characters", id: "asset-a" });
    expect(useAssetFormStore.getState().selForm["asset-a"]).toBe("variant-a");
    expect(save).not.toHaveBeenCalled();
    expect(scheduleAutoSave).not.toHaveBeenCalled();
  });

  it.each([
    { projectInstanceId: "rtc-asset-editing-project-B", isProjectLoading: false },
    { projectInstanceId: owner, isProjectLoading: true },
  ])("确认期间切项目或加载，不删除当前同 ID 资产：%j", state => {
    const deleting = deleteRtcAsset(owner, "characters", "asset-a");
    const replacement = asset("asset-a", "新项目同 ID 角色");
    const work = pending("new-project-task", "characters", "asset-a");
    useProjectStore.setState({ ...state, characters: [replacement] as any, pendingGens: [work] });
    useRtcAssetSelStore.getState().select({ cat: "characters", id: "asset-a" });
    useAssetFormStore.getState().setSelForm("asset-a", "new-project-form");
    settleConfirm(true);
    return deleting.then(result => {
      expect(result).toBe(false);
      expect(useProjectStore.getState().characters).toEqual([replacement]);
      expect(useProjectStore.getState().pendingGens).toEqual([work]);
      expect(useRtcAssetSelStore.getState().selected).toEqual({ cat: "characters", id: "asset-a" });
      expect(useAssetFormStore.getState().selForm["asset-a"]).toBe("new-project-form");
      expect(save).not.toHaveBeenCalled();
      expect(scheduleAutoSave).not.toHaveBeenCalled();
    });
  });

  it.each(["missing", "stale-owner", "loading"])("无效删除 %s 不弹确认也不写入", async mode => {
    if (mode === "loading") useProjectStore.setState({ isProjectLoading: true });
    const before = useProjectStore.getState().characters;
    expect(await deleteRtcAsset(mode === "stale-owner" ? "old-project" : owner, "characters", mode === "missing" ? "missing" : "asset-a")).toBe(false);
    expect(useConfirmStore.getState().open).toBe(false);
    expect(useProjectStore.getState().characters).toBe(before);
    expect(save).not.toHaveBeenCalled();
    expect(scheduleAutoSave).not.toHaveBeenCalled();
  });

  it("确认前目标消失时不继续保存或清空后来选中的资产", async () => {
    const deleting = deleteRtcAsset(owner, "characters", "asset-a");
    useProjectStore.setState({ characters: [asset("asset-b", "角色乙")] as any });
    useRtcAssetSelStore.getState().select({ cat: "characters", id: "asset-b" });
    settleConfirm(true);
    expect(await deleting).toBe(false);
    expect(useRtcAssetSelStore.getState().selected).toEqual({ cat: "characters", id: "asset-b" });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("RTC 资产删除范围", () => {
  it("删除当前资产只清该资产选中、造型与全部 pendingGens，保留其它任务", async () => {
    useRtcAssetSelStore.getState().select({ cat: "characters", id: "asset-a" });
    const keep = [pending("other-asset", "characters", "asset-b"), pending("other-cat", "scenes", "asset-a")];
    const shot: PendingGen = { id: "shot-job", shot: { episodeId: "ep", shotId: "shot", field: "storyboard" }, purpose: "storyboard.image", prompt: "提示词", label: "分镜", status: "running", createdAt: 1 };
    useProjectStore.setState({ pendingGens: [pending("base", "characters", "asset-a"), { ...pending("variant", "characters", "asset-a", "variant-a"), status: "failed" }, ...keep, shot] });
    const deleting = deleteRtcAsset(owner, "characters", "asset-a");
    settleConfirm(true);
    expect(await deleting).toBe(true);
    expect(useProjectStore.getState().characters.map(a => a.id)).toEqual(["asset-b"]);
    expect(useProjectStore.getState().scenes.map(a => a.id)).toEqual(["asset-a"]);
    expect(useProjectStore.getState().pendingGens).toEqual([...keep, shot]);
    expect(useRtcAssetSelStore.getState().selected).toBeNull();
    expect(useAssetFormStore.getState().selForm).toEqual({ "asset-a": null, "asset-b": "variant-b" });
    expect(useRtcStore.getState().selection).toEqual(["timeline-before-edit"]);
    expect(save).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([
    { cat: "characters" as const, id: "asset-b" },
    { cat: "scenes" as const, id: "asset-a" },
  ])("删除非当前资产保留其它选中：%j", async selection => {
    useRtcAssetSelStore.getState().select(selection);
    const deleting = deleteRtcAsset(owner, "characters", "asset-a");
    settleConfirm(true);
    expect(await deleting).toBe(true);
    expect(useRtcAssetSelStore.getState().selected).toEqual(selection);
    expect(useProjectStore.getState()[selection.cat].some(a => a.id === selection.id)).toBe(true);
    expect(useAssetFormStore.getState().selForm["asset-b"]).toBe("variant-b");
  });

  it("删除确认期间改选角色乙，确认后保留乙的工作台目标", async () => {
    useRtcAssetSelStore.getState().select({ cat: "characters", id: "asset-a" });
    const deleting = deleteRtcAsset(owner, "characters", "asset-a");
    useRtcAssetSelStore.getState().select({ cat: "characters", id: "asset-b" });
    settleConfirm(true);
    expect(await deleting).toBe(true);
    expect(useRtcAssetSelStore.getState().selected).toEqual({ cat: "characters", id: "asset-b" });
    expect(useAssetFormStore.getState().selForm["asset-b"]).toBe("variant-b");
  });

  it("删除资产不清当前媒体预览", async () => {
    const media = { key: "local-image", uri: "local.png", media: "image" as const, name: "本地图片" };
    useRtcAssetSelStore.getState().toggleMedia(media);
    const deleting = deleteRtcAsset(owner, "characters", "asset-a");
    settleConfirm(true);
    expect(await deleting).toBe(true);
    expect(useRtcAssetSelStore.getState().mediaSel).toEqual(media);
    expect(useRtcAssetSelStore.getState().selected).toBeNull();
  });
});
