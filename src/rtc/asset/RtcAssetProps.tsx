import { useEffect } from "react";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { useRtcAssetEditorSlotStore } from "./rtcAssetEditorSlotStore";

/** 右侧属性只提供编辑器挂载点；生成、预览与历史由共享资产工作台的同一会话管理。 */
export function RtcAssetProps({ cat, id }: { cat: AssetCat; id: string }) {
  const asset = useProjectStore(state => state[cat].find(item => item.id === id));
  useEffect(() => {
    if (!asset) {
      const selected = useRtcAssetSelStore.getState().selected;
      if (selected?.cat === cat && selected.id === id) useRtcAssetSelStore.getState().clear();
    }
  }, [asset, cat, id]);
  return asset ? <div ref={useRtcAssetEditorSlotStore.getState().setContainer} data-rtc-asset-editor-slot
    style={{ padding: 12, minWidth: 0, minHeight: 0, height: "100%", boxSizing: "border-box" }} /> : null;
}
