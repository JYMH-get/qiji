import { create } from "zustand";
import type {
	Catalog,
	CatalogModel,
	CatalogTemplate,
	CatalogPreset,
	CatalogImageTemplate,
	CatalogVariantPrefix,
	Capability,
	AssetType,
	Purpose,
} from "@/contract";
import { managedClient } from "@/services/managedClient";

/**
 * catalogStore —— 管理端远程下发目录的本地缓存。
 *
 * 这是"远程更新大模型/提示词/节点/出图模板/变体前缀"的入口。
 * 启动时先用本地缓存秒开，再后台 syncCatalog 拉增量。
 */

const LS_KEY = "Qiji:catalog";

function loadCache(): Catalog | null {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (raw) return JSON.parse(raw);
	} catch {
		/* ignore */
	}
	return null;
}

function saveCache(c: Catalog): void {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(c));
	} catch {
		/* ignore */
	}
}

interface CatalogState {
	catalog: Catalog | null;
	loading: boolean;
	error: string | null;

	syncCatalog: () => Promise<void>;

	// ── 选择器 ──
	models: () => CatalogModel[];
	modelsByCapability: (cap: Capability) => CatalogModel[];
	model: (id: string) => CatalogModel | undefined;
	templatesByPurpose: (p: Purpose) => CatalogTemplate[];
	/** 按节点类型筛可用模板（nodeTypes 白名单；缺省/空=不限，对所有节点可见） */
	templatesByNode: (nodeType: string) => CatalogTemplate[];
	/** 按分类取模板（如 "画风"），按 order/name 排序 */
	templatesByCategory: (category: string) => CatalogTemplate[];
	/** 预设清单（第174轮独立实体；旧服务端无 presets 字段=空数组，消费方需自带模板回退） */
	presets: () => CatalogPreset[];
	/** 画风预设列表（新服务端=presets 分组「画风」；旧服务端回退 category==="画风" 的模板），供新建项目选用 */
	artStyles: () => CatalogTemplate[];
	/** 取某 purpose（可叠加节点类型）下的默认模板（isDefault 优先，否则第一个） */
	defaultTemplate: (p: Purpose, nodeType?: string) => CatalogTemplate | undefined;
	imageTemplate: (type: AssetType, style: string) => CatalogImageTemplate | undefined;
	variantPrefix: (type: AssetType) => CatalogVariantPrefix | undefined;
	schema: (id: string) => unknown;
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
	catalog: loadCache(),
	loading: false,
	error: null,

	syncCatalog: async () => {
		set({ loading: true, error: null });
		try {
			const current = get().catalog?.version;
			const fresh = await managedClient.fetchCatalog(current);
			// 无更新：304 时 client 返回空对象（无 version/models），保留本地缓存
			if (fresh && fresh.version && fresh.version !== current) {
				saveCache(fresh);
				set({ catalog: fresh });
			} else if (fresh && fresh.models) {
				saveCache(fresh);
				set({ catalog: fresh });
			}
			// 目录变化后，重新注册模型适配器
			const { syncManagedAdapters } = await import("@/services/adapters/managedAdapter");
			syncManagedAdapters();
		} catch (err) {
			set({ error: (err as Error).message });
		} finally {
			set({ loading: false });
		}
	},

	models: () => get().catalog?.models ?? [],
	modelsByCapability: (cap) => (get().catalog?.models ?? []).filter((m) => m.capability === cap),
	model: (id) => (get().catalog?.models ?? []).find((m) => m.id === id),
	templatesByPurpose: (p) => (get().catalog?.templates ?? []).filter((t) => t.purpose === p),
	templatesByNode: (nodeType) =>
		(get().catalog?.templates ?? []).filter(
			(t) =>
				// 预设类（无 purpose，如画风）不可执行，不进节点模板选择器
				!!t.purpose &&
				(!t.nodeTypes || t.nodeTypes.length === 0 || t.nodeTypes.includes(nodeType)),
		),
	templatesByCategory: (category) =>
		(get().catalog?.templates ?? []).filter((t) => (t.category ?? "") === category),
	presets: () => get().catalog?.presets ?? [],
	// 画风：新服务端从独立预设库取（映射成 CatalogTemplate 形状，消费方 Frame164 等零改动）；
	// 旧服务端（无 presets 字段）回退旧口径（画风还在模板清单里）。
	artStyles: () => {
		const presets = get().catalog?.presets;
		if (presets) {
			return presets
				.filter((p) => (p.category ?? "") === "画风")
				.map((p) => ({
					id: p.id,
					name: p.name,
					capability: "image" as Capability,
					variables: [],
					category: "画风",
					body: p.body,
					images: p.images,
				}));
		}
		return (get().catalog?.templates ?? []).filter((t) => (t.category ?? "") === "画风");
	},
	defaultTemplate: (p, nodeType) => {
		const pool = (get().catalog?.templates ?? []).filter(
			(t) =>
				t.purpose === p &&
				(!nodeType || !t.nodeTypes || t.nodeTypes.length === 0 || t.nodeTypes.includes(nodeType)),
		);
		return pool.find((t) => t.isDefault) ?? pool[0];
	},
	imageTemplate: (type, style) =>
		(get().catalog?.imageTemplates ?? []).find((t) => t.assetType === type && t.style === style) ??
		(get().catalog?.imageTemplates ?? []).find((t) => t.assetType === type), // 画风缺省回退到该类型任一模板
	variantPrefix: (type) => (get().catalog?.variantPrefixes ?? []).find((v) => v.assetType === type),
	schema: (id) => get().catalog?.schemas?.[id],
}));
