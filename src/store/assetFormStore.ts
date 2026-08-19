import { create } from "zustand";

/**
 * 资产助手「当前选中造型」共享态：资产实体 id → variantId（null=基础形象）。
 * 资产助手右击「选择造型」写入；视频界面「提取资产」优先取该造型的图作素材。
 * 会话态（不持久化，重开回默认基础形象）。
 */
interface AssetFormState {
    selForm: Record<string, string | null>;
    setSelForm: (assetId: string, variantId: string | null) => void;
}

export const useAssetFormStore = create<AssetFormState>((set) => ({
    selForm: {},
    setSelForm: (assetId, variantId) =>
        set((s) => ({ selForm: { ...s.selForm, [assetId]: variantId } })),
}));
