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
}

interface LibraryState {
	assets: Record<AssetId, Asset>;
	addAsset: (asset: Asset) => void;
	/** 仅用户可删除；软删除，系统不自动 GC */
	deleteAsset: (id: AssetId) => void;
}

export const useLibraryStore = create<LibraryState>((set) => ({
	assets: {},
	addAsset: (asset) =>
		set((s) => ({ assets: { ...s.assets, [asset.id]: asset } })),
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
