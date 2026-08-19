/**
 * 收藏（P1）——从 localStorage 搬到服务端。
 *
 * 为什么必须搬：旧实现是 `Qiji:favoriteAssets` 按**显示 uri** 存在本机的，
 *  - 换台机器就没了，服务端完全不知情；
 *  - 而清理策略上线后，「有没有收藏」直接决定素材是永久保留还是 14 天后消失 ——
 *    一个换机即失效、服务端看不见的收藏，起不到这个作用。
 * 新实现按 **assetId**（id 是真理，§2）落服务端 favorites 表。
 *
 * 配额语义（务必在 UI 上说对）：收藏 = **永久保留额度**，不是「存不存得下」。
 * 超额只挡新增收藏，用户照常生成、照常使用已有素材。
 */
import { create } from "zustand";
import { managedClient } from "@/services/managedClient";

export interface FavQuota {
	limitBytes: number;
	usedBytes: number;
	baseBytes: number;
	grantBytes: number;
	count: number;
}
export interface FavoriteItem {
	assetId: string;
	createdAt: number;
	type: string;
	contentType: string;
	name?: string;
	url: string;
	sizeBytes: number;
	/** 平台也收藏了（管理端审核钉住）：用户取消也不会掉出永久保留 */
	platformPinned: boolean;
}
export interface QuotaGrant {
	id: string;
	bytes: number;
	code?: string;
	grantedAt: number;
	expiresAt: number;
}

interface FavState {
	/** 已收藏的 assetId（渲染 ☆ 只查这个 Set，O(1)） */
	ids: Set<string>;
	items: FavoriteItem[];
	quota: FavQuota | null;
	grants: QuotaGrant[];
	loading: boolean;
	loaded: boolean;
	/** 最近一次操作的错误（超配额等），供 UI 提示；读取后自行清空 */
	lastError: string;

	load: (force?: boolean) => Promise<void>;
	isFav: (assetId?: string | null) => boolean;
	/** 返回是否成功；失败原因在 lastError */
	toggle: (assetId: string) => Promise<boolean>;
	redeemStorageCode: (code: string) => Promise<{ ok: boolean; error?: string }>;
	clearError: () => void;
	reset: () => void;
}

export const useFavoritesStore = create<FavState>((set, get) => ({
	ids: new Set(),
	items: [],
	quota: null,
	grants: [],
	loading: false,
	loaded: false,
	lastError: "",

	load: async (force = false) => {
		if (get().loading || (get().loaded && !force)) return;
		set({ loading: true });
		try {
			const r = await managedClient.listFavorites();
			set({
				items: r.items,
				ids: new Set(r.items.map((i) => i.assetId)),
				quota: r.quota,
				grants: r.grants ?? [],
				loaded: true,
			});
		} catch {
			// 未登录/离线：保持空态，不报错打扰（收藏是增强功能，不该阻断资产助手）
			set({ loaded: true });
		} finally {
			set({ loading: false });
		}
	},

	isFav: (assetId) => (assetId ? get().ids.has(assetId) : false),

	toggle: async (assetId) => {
		const was = get().ids.has(assetId);
		try {
			if (was) {
				const r = await managedClient.removeFavorite(assetId);
				const ids = new Set(get().ids);
				ids.delete(assetId);
				set({ ids, items: get().items.filter((i) => i.assetId !== assetId), quota: r.quota ?? get().quota });
			} else {
				const r = await managedClient.addFavorite(assetId);
				const ids = new Set(get().ids);
				ids.add(assetId);
				set({ ids, quota: r.quota ?? get().quota });
				void get().load(true); // 拉回完整条目（含 url/size，服务端说了算）
			}
			return true;
		} catch (e) {
			set({ lastError: (e as Error).message || "操作失败" });
			return false;
		}
	},

	redeemStorageCode: async (code) => {
		try {
			await managedClient.redeemStorageCode(code);
			await get().load(true);
			return { ok: true };
		} catch (e) {
			return { ok: false, error: (e as Error).message || "核销失败" };
		}
	},

	clearError: () => set({ lastError: "" }),
	reset: () => set({ ids: new Set(), items: [], quota: null, grants: [], loaded: false, lastError: "" }),
}));
