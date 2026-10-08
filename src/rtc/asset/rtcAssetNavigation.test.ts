import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { useRtcCenterTabStore } from "../panel/rtcCenterTabStore";
import { useRtcPropsTabStore } from "../panel/rtcPropsTabStore";
import { openRtcAssetWorkbench } from "./rtcAssetNavigation";

const asset = { cat: "characters" as const, id: "character-a" };
beforeEach(() => {
  useProjectStore.setState({ isProjectLoading: false, characters: [{ id: asset.id, name: "角色甲", prompt: "甲的形象" }] as any });
  useRtcAssetSelStore.getState().clear();
  useRtcStore.getState().setSelection(["old-shot"]);
  useRtcCenterTabStore.setState({ tab: "overview", scriptEditorOpen: true, scriptEditorHidden: false });
  useRtcPropsTabStore.getState().setTab("shots");
});

describe("资产工作台显式导航", () => {
  it("点击未出图资产打开中栏并清时间轴焦点、隐藏剧本草稿", () => {
    const revision = useRtcStore.getState().workbenchFocusRevision;
    openRtcAssetWorkbench(asset);
    expect(useRtcAssetSelStore.getState().selected).toEqual(asset);
    expect(useRtcStore.getState().selection).toEqual([]);
    expect(useRtcStore.getState().workbenchFocusRevision).toBeGreaterThan(revision);
    expect(useRtcCenterTabStore.getState()).toMatchObject({ tab: "preview", scriptEditorOpen: true, scriptEditorHidden: true });
    expect(useRtcPropsTabStore.getState().tab).toBe("props");
  });
  it("重复点击已选资产恢复预览和属性，不关闭编辑目标", () => {
    useRtcAssetSelStore.getState().select(asset);
    useRtcCenterTabStore.getState().setTab("workbench");
    openRtcAssetWorkbench(asset);
    expect(useRtcAssetSelStore.getState().selected).toEqual(asset);
    expect(useRtcCenterTabStore.getState().tab).toBe("preview");
    useRtcPropsTabStore.getState().setTab("script");
    openRtcAssetWorkbench(asset);
    expect(useRtcAssetSelStore.getState().selected).toEqual(asset);
    expect(useRtcPropsTabStore.getState().tab).toBe("props");
  });
  it("拒绝失效或正在切换项目的资产，不改变当前页", () => {
    openRtcAssetWorkbench({ ...asset, id: "missing" });
    expect(useRtcCenterTabStore.getState().tab).toBe("overview");
    useProjectStore.setState({ isProjectLoading: true });
    openRtcAssetWorkbench(asset);
    expect(useRtcAssetSelStore.getState().selected).toBeNull();
  });
});
