import type { AssetId } from "@/types";

/**
 * 资产 ID：全局唯一、单调递增、永不复用。
 * Phase 0 用本地内存计数；落地时换为后端持久序列。
 */
let counter = 0;
export function nextAssetId(): AssetId {
	counter += 1;
	return `asset-${String(counter).padStart(8, "0")}`;
}

export interface StoredAsset {
	id: AssetId;
	uri: string;
	thumbnailUri: string | null;
}

/** AssetStore 抽象：当前本地/内存；切 S3 只换实现，节点只存 assetId */
export interface AssetStore {
	put(blob: Blob | string, kind: string): Promise<StoredAsset>;
	get(id: AssetId): Promise<StoredAsset | null>;
}

export class LocalAssetStore implements AssetStore {
	private map = new Map<AssetId, StoredAsset>();
	async put(blob: Blob | string): Promise<StoredAsset> {
		const id = nextAssetId();
		const uri = typeof blob === "string" ? blob : URL.createObjectURL(blob);
		const asset: StoredAsset = { id, uri, thumbnailUri: null };
		this.map.set(id, asset);
		return asset;
	}
	async get(id: AssetId): Promise<StoredAsset | null> {
		return this.map.get(id) ?? null;
	}
}

export const assetStore: AssetStore = new LocalAssetStore();
