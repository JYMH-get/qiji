import AssetWorkbench from "@/components/AssetWorkbench";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { ASSET_CAT_LABEL, ASSET_IMAGE_PURPOSE } from "../panel/assetGenActions";
import { useRtcAssetEditorSlotStore } from "./rtcAssetEditorSlotStore";
import { RtcAssetForms } from "./RtcAssetForms";
import { useEffectiveModelKey } from "@/components/ModelPicker";
import { useCatalogStore } from "@/store/catalogStore";
import { buildImageParams } from "@/lib/genParams";
import { imageResolutionOptionsForKey } from "@/lib/modelOptions";

/** 共享一个资产生成会话：中央预览，编辑控件传送到右侧属性栏。 */
export function RtcAssetWorkbench({ cat, id }: { cat: AssetCat; id: string }) {
  const asset = useProjectStore(state => state[cat].find(item => item.id === id));
  const loading = useProjectStore(state => state.isProjectLoading);
  const variantId = useAssetFormStore(state => state.selForm[id]);
  const container = useRtcAssetEditorSlotStore(state => state.container);
  const settings = useProjectStore(state => state.mediaSettings);
  const modelKey = useEffectiveModelKey("image");
  useCatalogStore(state => state.catalog);
  if (loading || !asset) return null;
  const formKey = variantId && asset.variants?.some(variant => variant.id === variantId) ? variantId : "base";
  const hasVoice = cat === "characters" || cat === "crowds";
  const imageParams = buildImageParams({ aspect: settings.imageAspect ?? "16:9",
    ...(settings.imageResolution !== undefined ? { resolution: settings.imageResolution } : {}),
    quality: settings.imageQuality ?? "high" }, imageResolutionOptionsForKey(modelKey));
  return <div aria-label="资产预览工作区" style={{ display: "flex", flex: 1, minWidth: 0, minHeight: 0 }}>
    <RtcAssetForms cat={cat} id={id} />
    <AssetWorkbench cat={cat} unit={ASSET_CAT_LABEL[cat]} imagePurpose={ASSET_IMAGE_PURPOSE[cat]}
    textField={hasVoice ? "features" : "description"} showVoice={hasVoice}
    embeddedTarget={{ assetId: id, formKey }} embeddedEditorPortal={container} embeddedImageParams={imageParams} />
  </div>;
}
