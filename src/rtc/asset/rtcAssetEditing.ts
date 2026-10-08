import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { confirmDialog } from "@/lib/confirmDialog";
import { genId } from "@/lib/id";
import { useRtcAssetSelStore } from "../rtcAssetSelStore";
import { openRtcAssetWorkbench } from "./rtcAssetNavigation";

export function createRtcAsset(owner: string, cat: AssetCat, name: string): string | null {
  const project = useProjectStore.getState();
  if (project.projectInstanceId !== owner || project.isProjectLoading || !name.trim()) return null;
  const id = genId(cat);
  const field = cat === "characters" || cat === "crowds" ? "features" : "description";
  project.addAsset(cat, { id, name: name.trim(), [field]: "", philosophy: "", prompt: "", images: [], variants: [] });
  useAssetFormStore.getState().setSelForm(id, null);
  openRtcAssetWorkbench({ cat, id });
  return id;
}

export async function deleteRtcAsset(owner: string, cat: AssetCat, id: string): Promise<boolean> {
  const current = () => {
    const project = useProjectStore.getState();
    return project.projectInstanceId === owner && !project.isProjectLoading ? project[cat].find(asset => asset.id === id) : undefined;
  };
  const asset = current();
  if (!asset || !await confirmDialog(`删除「${asset.name}」及其所有分体与历史图？`, "删除资产") || !current()) return false;
  useProjectStore.getState().removeAsset(cat, id);
  const selection = useRtcAssetSelStore.getState();
  if (selection.selected?.cat === cat && selection.selected.id === id) selection.clear();
  useAssetFormStore.getState().setSelForm(id, null);
  void useProjectStore.getState().save(true);
  return true;
}
