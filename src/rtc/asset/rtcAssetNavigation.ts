import { useProjectStore } from "@/store/projectStore";
import { useRtcStore } from "@/store/rtcStore";
import { useRtcAssetSelStore, type RtcAssetSel } from "../rtcAssetSelStore";
import { useRtcCenterTabStore } from "../panel/rtcCenterTabStore";
import { useRtcPropsTabStore } from "../panel/rtcPropsTabStore";

/** 左栏明确点击才导航；生成回填与播放头移动不切中央页签。 */
export function openRtcAssetWorkbench(target: RtcAssetSel): void {
  const project = useProjectStore.getState();
  if (project.isProjectLoading || !project[target.cat].some(asset => asset.id === target.id)) return;
  const assets = useRtcAssetSelStore.getState();
  const center = useRtcCenterTabStore.getState();
  assets.select(target);
  useRtcStore.getState().setSelection([]);
  useRtcPropsTabStore.getState().setTab("props");
  center.setTab("preview");
}
