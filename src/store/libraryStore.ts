import { create } from "zustand";
import type { AssetId } from "@/types";

export interface Asset {
	id: AssetId;
	kind: "image" | "video" | "audio" | "script";
	name: string;
	uri: string;
	thumbnailUri: string | null;
	createdAt: string;
	/** 软删除：ID 永不复用 */
	deletedByUser: boolean;
	localPath?: string | null;
	/** 管理端分配的真资产 id（OSS 台账中的 id；id 为真理、uri 为公网直链）。用于垫图引用 */
	serverAssetId?: string | null;
	/** 来源：upload=用户本地上传（进「本地素材库」）；generated=节点生成/资产助手派生（不进本地素材库） */
	origin?: "upload" | "generated";
	/** 归属分集（实时剪辑分集化：导入时打上当前分集 id；缺省=不分集的旧素材，各分集都显示） */
	episodeId?: string | null;
}

interface LibraryState {
	assets: Record<AssetId, Asset>;
	addAsset: (asset: Asset) => void;
	/** 仅用户可删除；软删除，系统不自动 GC */
	deleteAsset: (id: AssetId) => void;
}

export const useLibraryStore = create<LibraryState>((set) => ({
	assets: {},
	addAsset: (asset) => {
		set((s) => ({ assets: { ...s.assets, [asset.id]: asset } }));
	},
	deleteAsset: (id) =>
		set((s) =>
			s.assets[id]
				? {
						assets: {
							...s.assets,
							[id]: { ...s.assets[id], deletedByUser: true },
						},
					}
				: s,
		),
}));