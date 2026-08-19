/**
 * rtcAssetData —— 实时剪辑左栏资产面板的数据汇集层（纯函数，可单测，零 store 依赖）。
 *
 * 数据读取语义与 AssetAssistant 完全同构（该组件只读参考、绝不修改）：
 *  - 三大类 Major = "project" | "favorite" | "shared"；
 *  - 项目五类资产（角色/场景/生物/群像/道具）一资产一卡，显示当前选中造型（assetFormStore.selForm）；
 *    变体/造型**收敛在主体卡内不单独占格**（与 AssetAssistant 同规：卡带造型清单供右键选择）；
 *    **无图资产（资产拆分刚提取、尚未出图）以「占位符卡」显示**（placeholders 选项开启时；
 *    排分类最前，点击选中→右栏编辑提示词出图；无媒体不可拖拽）；
 *  - 收藏（favoritesStore，服务端为准）与共享（sharedLibStore 本地缓存）按台账 id 前缀分类；
 *  - **新增媒体分类**（本面板扩展）：
 *      视频 = 本项目分镜成片（shot.videoUri/videoUris/videoDerived 成品）∪ 素材库 kind=video 资产，去重；
 *      音频 = 资产绑定音色（voiceUri）∪ 素材库 kind=audio 资产。
 *
 * ⚠ 拖拽 payload（application/x-qiji-asset）与 AssetAssistant 完全同构——时间轴/右栏垫图区的
 *   drop 端按同一 MIME 解析，这是硬约定：
 *   { source:"qiji-asset", assetId, url, localUri, localPath, name, kind, cat }
 *   媒体类**只加字段不改既有字段**：media:"video"|"audio" + （时长可得时）durationSec。
 */
import type { AssetCat } from "@/store/projectStore";
import type { AssetBlob, VideoEpisode } from "@/services/projectFile";
import type { Asset as LibraryAsset } from "@/store/libraryStore";
import type { CachedSharedAsset } from "@/store/sharedLibStore";
import type { FavoriteItem } from "@/store/favoritesStore";

export type RtcMajor = "project" | "favorite" | "shared";
/** 面板小分类 = 助手六类（五类 + 其他） + 新增「视频」「音频」两个媒体分类 */
export type RtcSubCat = AssetCat | "others" | "videos" | "audios";
export type RtcMedia = "image" | "video" | "audio";

export const RTC_MAJORS: Array<{ v: RtcMajor; label: string }> = [
	{ v: "project", label: "项目资产" },
	{ v: "favorite", label: "收藏资产" },
	{ v: "shared", label: "共享资产" },
];

/** 项目五类资产分类（可选中出图的分类；与 projectStore AssetCat 全集一致） */
export const ASSET_CATS: AssetCat[] = ["characters", "scenes", "organisms", "crowds", "items"];

/** 面板小分类是否为项目五类资产（选中出图/右栏资产视图只对这五类有语义） */
export function isAssetCat(cat: RtcSubCat): cat is AssetCat {
	return (ASSET_CATS as RtcSubCat[]).includes(cat);
}

export const RTC_SUBS: Array<{ v: RtcSubCat; label: string }> = [
	{ v: "characters", label: "角色" },
	{ v: "scenes", label: "场景" },
	{ v: "organisms", label: "生物" },
	{ v: "crowds", label: "群像" },
	{ v: "items", label: "道具" },
	{ v: "others", label: "其他" },
	{ v: "videos", label: "视频" },
	{ v: "audios", label: "音频" },
];

/** 一个「造型」（基础形象或某变体，仅含已出图）——右键主体卡弹造型选单切换（与 AssetAssistant 同规） */
export interface RtcAssetForm {
	variantId: string | null;
	label: string;
	name: string;
	uri: string;
}

/** 面板卡片条目（一卡一条） */
export interface RtcAssetItem {
	/** 稳定去重/选中键：台账 assetId 优先，退 uri */
	key: string;
	/** 显示 uri（本地副本优先；CSP：Tauri 下 http(s) 图不能直显，§9）；占位符卡为空串 */
	uri: string;
	name: string;
	cat: RtcSubCat;
	media: RtcMedia;
	/** 资产 id（台账 id / LC- 本地 id；可缺省） */
	id?: string;
	/** 无图占位符卡（资产已拆分尚未出图）：不可拖拽入轨/垫图，点击选中在右栏生成图片；出图后随 store 订阅自动变正常图卡（key 不变） */
	placeholder?: boolean;
	/** 该资产的全部已出图造型（基础+变体；仅项目五类图片卡携带）——数量>1 时卡片显示「N造型」角标并可右键选择 */
	forms?: RtcAssetForm[];
	/** 当前显示的造型（null=基础形象；右键造型选单 active 判定） */
	variantId?: string | null;
	/** 资产基础名（造型选单标题用；name 可能带「·造型」后缀） */
	baseName?: string;
	/** 视频时长（秒，可得时；来自分镜 durationSec，随 payload 下发供时间轴按时长入轨） */
	durationSec?: number;
	/** 绑定音色（项目图片卡显示音频角标用） */
	voiceUri?: string;
	voiceName?: string;
	/** 共享素材原始记录：拖拽前须先登记进三元映射（drop 端凭 blobByUri 解析公网 url） */
	sharedRec?: CachedSharedAsset;
}

/**
 * 拖拽 payload（⚠ 硬约定，与 AssetAssistant onCardDragStart 同构；改字段前先查两处 drop 端）。
 * 图片卡与助手逐字段一致（kind:"image"、无 media 字段）；媒体卡 kind=media 值并补 media/durationSec。
 */
export interface QijiAssetPayload {
	source: "qiji-asset";
	assetId?: string;
	url: string;
	localUri: string;
	localPath?: string;
	name: string;
	kind: RtcMedia;
	cat: RtcSubCat;
	/** 媒体类补充字段（仅 video/audio 卡携带；只加不改，保持向后兼容） */
	media?: "video" | "audio";
	durationSec?: number;
}

/** 台账 id 前缀 → 分类（id 是真理；与 AssetAssistant sharedCatOf 同规，另加 video/audio 前缀归媒体类） */
export function rtcCatOfId(assetId: string | undefined | null): RtcSubCat {
	const id = assetId || "";
	if (/^[CA]\d/.test(id)) return "characters";
	if (/^G\d/.test(id)) return "crowds";
	if (/^M\d/.test(id)) return "organisms";
	if (/^S\d/.test(id)) return "scenes";
	if (/^P\d/.test(id)) return "items";
	if (/^video/i.test(id)) return "videos";
	if (/^audio/i.test(id)) return "audios";
	return "others";
}

/** mime → 媒体模态（缺省按图像，兼容旧数据——与共享面板同规） */
export function mediaOfMime(mime: string | undefined | null): RtcMedia {
	if (mime?.startsWith("video/")) return "video";
	if (mime?.startsWith("audio/")) return "audio";
	return "image";
}

/* ── 项目五类图片资产（一资产一卡，显示当前选中造型；与 AssetAssistant projectItems 同逻辑） ── */

export interface ProjectCatAsset {
	id: string;
	name: string;
	image?: string;
	images?: string[];
	variants?: Array<{ id: string; label?: string; image?: string; images?: string[] }>;
	voiceUri?: string;
	voiceAssetId?: string;
	voiceName?: string;
}

/**
 * 收敛一个资产的全部**已出图**造型（基础形象 + 有图变体）——与 AssetAssistant 卡片造型选单同一份清单。
 * 右栏资产视图的「分体选择」网格与左栏「N造型」右键选单共用（同源数据，三方与 assetFormStore 天然同步）。
 */
export function collectAssetForms(a: ProjectCatAsset): RtcAssetForm[] {
	const forms: RtcAssetForm[] = [];
	if (a.image) forms.push({ variantId: null, label: "基础形象", name: a.name, uri: a.image });
	for (const v of a.variants ?? []) if (v.image) forms.push({ variantId: v.id, label: v.label || "造型", name: `${a.name}·${v.label || "造型"}`, uri: v.image });
	return forms;
}

export function collectProjectImageItems(
	assets: ProjectCatAsset[],
	cat: AssetCat,
	selForm: Record<string, string | null>,
	/** placeholders=true 时无图资产以占位符卡返回并**排分类最前**（面板用）；
	 *  缺省 false 保持旧语义「无图不返回」——RtcCenterStage 的资产预览叠层依赖旧语义走自己的「尚未出图」兜底。 */
	opts?: { placeholders?: boolean },
): RtcAssetItem[] {
	const out: RtcAssetItem[] = [];
	const placeholders: RtcAssetItem[] = [];
	for (const a of assets ?? []) {
		const forms = collectAssetForms(a);
		if (forms.length === 0) {
			// 尚无任何已出图造型 → 占位符卡（排最前：刚拆分的资产要出图，放前面顺手）；未开启时不显示（旧语义）
			if (opts?.placeholders) {
				placeholders.push({ key: a.id || `ph:${cat}:${a.name}`, uri: "", name: a.name || "未命名资产", cat, media: "image", id: a.id, placeholder: true });
			}
			continue;
		}
		const sel = a.id ? selForm[a.id] : undefined;
		const cur = forms.find((f) => f.variantId === (sel ?? null)) ?? forms[0];
		out.push({
			key: a.id || cur.uri, uri: cur.uri, name: cur.name, cat, media: "image", id: a.id,
			variantId: cur.variantId, baseName: a.name, forms,
			voiceUri: a.voiceUri, voiceName: a.voiceName,
		});
	}
	return placeholders.length ? [...placeholders, ...out] : out;
}

/** 「图片」分类：素材库图片。缺省只收本地导入（origin=upload，画布本地素材库语义）；
 *  includeGenerated=true 时连画布生成物一并收（实时剪辑素材页——按分集过滤后不再乱） */
export function collectLibraryImageItems(libraryAssets: LibraryAsset[], opts?: { includeGenerated?: boolean }): RtcAssetItem[] {
	return libraryAssets
		.filter((a) => a.kind === "image" && (a.origin === "upload" || !!opts?.includeGenerated) && !a.deletedByUser)
		.map((a) => ({ key: a.serverAssetId || a.id, uri: a.uri, name: a.name, cat: "others" as const, media: "image" as const, id: a.serverAssetId || a.id }));
}

/* ── 「视频」分类：分镜成片 ∪ 素材库 video 资产，去重 ── */

/**
 * 汇集本项目视频：episodes[].shots[] 的 videoUri（主视频）/ videoUris（历史）/ videoDerived
 * （超分/去字幕成品，running/failed 跳过）+ 素材库 kind=video 资产。
 * 去重键 = blobByUri(uri)?.id（台账 id 优先）→ 显式 id → uri；分镜成片显示「集号·镜号」。
 */
export function collectVideoItems(
	episodes: VideoEpisode[],
	libraryAssets: LibraryAsset[],
	blobByUri: (uri: string) => AssetBlob | undefined,
): RtcAssetItem[] {
	const out: RtcAssetItem[] = [];
	const seen = new Set<string>();
	const push = (uri: string | undefined, name: string, durationSec?: number, id?: string) => {
		if (!uri) return;
		const blob = blobByUri(uri);
		const key = blob?.id || id || uri;
		if (seen.has(key) || seen.has(uri)) return;
		seen.add(key);
		seen.add(uri);
		out.push({
			key, uri, name, cat: "videos", media: "video", id: blob?.id || id,
			...(durationSec && durationSec > 0 ? { durationSec } : {}),
		});
	};
	const multiEp = (episodes ?? []).length > 1;
	for (const ep of episodes ?? []) {
		for (const shot of ep.shots ?? []) {
			const base = multiEp ? `${ep.index}集·${shot.title}` : shot.title;
			push(shot.videoUri, base, shot.durationSec);
			for (const u of shot.videoUris ?? []) push(u, base, shot.durationSec);
			for (const d of shot.videoDerived ?? []) {
				if (d.status === "running" || d.status === "failed") continue; // 只收成品
				push(d.uri, d.label ? `${base}·${d.label}` : base, shot.durationSec);
			}
		}
	}
	for (const a of libraryAssets) {
		if (a.kind !== "video" || a.deletedByUser) continue;
		push(a.uri, a.name, undefined, a.serverAssetId || a.id);
	}
	return out;
}

/* ── 「音频」分类：资产绑定音色 ∪ 素材库 audio 资产 ── */

export function collectAudioItems(
	voiceOwners: ProjectCatAsset[],
	libraryAssets: LibraryAsset[],
	blobByUri: (uri: string) => AssetBlob | undefined,
): RtcAssetItem[] {
	const out: RtcAssetItem[] = [];
	const seen = new Set<string>();
	const push = (uri: string | undefined, name: string, id?: string) => {
		if (!uri) return;
		const blob = blobByUri(uri);
		const key = blob?.id || id || uri;
		if (seen.has(key) || seen.has(uri)) return;
		seen.add(key);
		seen.add(uri);
		out.push({ key, uri, name, cat: "audios", media: "audio", id: blob?.id || id });
	};
	for (const a of voiceOwners) {
		if (!a.voiceUri) continue;
		push(a.voiceUri, a.voiceName || `${a.name}·音色`, a.voiceAssetId);
	}
	for (const a of libraryAssets) {
		if (a.kind !== "audio" || a.deletedByUser) continue;
		push(a.uri, a.name, a.serverAssetId || a.id);
	}
	return out;
}

/* ── 收藏 / 共享 ── */

/** 收藏条目 → 面板条目（分类按台账 id 前缀 + contentType 双判；本地副本优先显示） */
export function collectFavoriteItems(
	favItems: FavoriteItem[],
	assetBlobs: Record<string, AssetBlob>,
): RtcAssetItem[] {
	return favItems.map((f) => {
		const media = mediaOfMime(f.contentType);
		const cat: RtcSubCat = media === "video" ? "videos" : media === "audio" ? "audios" : rtcCatOfId(f.assetId);
		return {
			key: f.assetId,
			uri: assetBlobs[f.assetId]?.localUri || f.url,
			name: f.name || f.assetId,
			cat, media, id: f.assetId,
		};
	});
}

/** 单个共享文件夹的已下载素材 → 面板条目（共享页按 库→文件夹 层级浏览，参考资产助手；
 *  未下载到本地的不显示——「获取」入口仍在资产助手） */
export function collectSharedFolderItems(records: CachedSharedAsset[]): RtcAssetItem[] {
	const out: RtcAssetItem[] = [];
	const seen = new Set<string>();
	for (const rec of records ?? []) {
		if (!rec.localUri) continue;
		const key = rec.assetId || rec.id;
		if (seen.has(key)) continue;
		seen.add(key);
		const media = mediaOfMime(rec.mime);
		const cat: RtcSubCat = media === "video" ? "videos" : media === "audio" ? "audios" : rtcCatOfId(rec.assetId);
		out.push({ key, uri: rec.localUri, name: rec.name, cat, media, id: rec.assetId || rec.id, sharedRec: rec });
	}
	return out;
}

/** 共享缓存（全部文件夹摊平，仅本地已下载的）→ 面板条目；素材获取/加入库仍在资产助手操作 */
export function collectSharedItems(assetsByFolder: Record<string, CachedSharedAsset[]>): RtcAssetItem[] {
	const out: RtcAssetItem[] = [];
	const seen = new Set<string>();
	for (const list of Object.values(assetsByFolder)) {
		for (const rec of list ?? []) {
			if (!rec.localUri) continue; // 未下载到本地的不显示（获取入口在资产助手）
			const key = rec.assetId || rec.id;
			if (seen.has(key)) continue;
			seen.add(key);
			const media = mediaOfMime(rec.mime);
			const cat: RtcSubCat = media === "video" ? "videos" : media === "audio" ? "audios" : rtcCatOfId(rec.assetId);
			out.push({ key, uri: rec.localUri, name: rec.name, cat, media, id: rec.assetId || rec.id, sharedRec: rec });
		}
	}
	return out;
}

/* ── 分集过滤（实时剪辑分集化：防素材堆积过多卡顿） ── */

/** 画布节点形状（分集归属反查只读 resultAssetId/resultHistory，结构化类型防重依赖） */
interface CanvasNodeLike {
	data?: { resultAssetId?: string | null; resultHistory?: string[] } | null;
}

/**
 * 画布生成物 → 分集归属反查表（用户定稿「画布生成物也加进来」；分集三模同步：每分集一块画布，
 * 画布上节点的产物即该集产物）。从各分集画布快照 + 激活画布的实时节点收集 resultAssetId/
 * resultHistory → 分集 id；**激活画布先收**（实时数据最新，同资产出现在多块画布时激活者胜）。
 * 覆盖 episodeId 打标机制上线前的存量生成物（打了标的以 Asset.episodeId 为准，见过滤函数）。
 */
export function buildCanvasAssetEpisodeMap(
	canvases: Record<string, { nodes?: Record<string, CanvasNodeLike> } | undefined>,
	activeEpisodeId: string,
	activeNodes: Record<string, CanvasNodeLike>,
): Map<string, string> {
	const map = new Map<string, string>();
	const collect = (nodes: Record<string, CanvasNodeLike> | undefined, epId: string) => {
		if (!nodes || !epId) return;
		for (const n of Object.values(nodes)) {
			const d = n?.data;
			if (!d) continue;
			if (d.resultAssetId && !map.has(d.resultAssetId)) map.set(d.resultAssetId, epId);
			for (const id of d.resultHistory ?? []) if (id && !map.has(id)) map.set(id, epId);
		}
	};
	collect(activeNodes, activeEpisodeId);
	for (const [epId, c] of Object.entries(canvases)) {
		if (epId === activeEpisodeId) continue; // 激活画布以 canvasStore 实时数据为准（快照可能陈旧）
		collect(c?.nodes, epId);
	}
	return map;
}

/**
 * 素材库条目按分集过滤：留 **当前分集的**（Asset.episodeId 打标命中，或经画布归属反查表
 * attribution 命中）+ **两处都查不到归属的旧素材**（各分集都显示——不迁移不隐藏）。
 * episodeKey 为空（无分集）不过滤；无变化时保持原引用。
 */
export function filterLibraryByEpisode(
	assets: LibraryAsset[],
	episodeKey: string,
	attribution?: Map<string, string>,
): LibraryAsset[] {
	if (!episodeKey) return assets;
	const out = assets.filter((a) => {
		const ep = a.episodeId ?? attribution?.get(a.serverAssetId || a.id) ?? attribution?.get(a.id);
		return !ep || ep === episodeKey;
	});
	return out.length === assets.length ? assets : out;
}

/* ── 搜索 / payload ── */

/** 按名称过滤（简单 includes，大小写不敏感） */
export function filterByQuery(items: RtcAssetItem[], q: string): RtcAssetItem[] {
	const s = q.trim().toLowerCase();
	if (!s) return items;
	return items.filter((it) => it.name.toLowerCase().includes(s));
}

/**
 * 组装拖拽 payload（⚠ 与 AssetAssistant onCardDragStart 同构，勿改既有字段）：
 * url=公网 url 优先（请求用）、localUri=显示 uri、assetId=台账 id；
 * 媒体卡追加 media 与（可得时）durationSec——只加字段，drop 端旧逻辑零影响。
 */
export function buildAssetPayload(item: RtcAssetItem, blob: AssetBlob | undefined): QijiAssetPayload {
	const payload: QijiAssetPayload = {
		source: "qiji-asset",
		assetId: blob?.id || item.id,
		url: blob?.url || item.uri,
		localUri: item.uri,
		localPath: blob?.localPath,
		name: item.name,
		kind: item.media,
		cat: item.cat,
	};
	if (item.media === "video" || item.media === "audio") {
		payload.media = item.media;
		if (item.durationSec && item.durationSec > 0) payload.durationSec = item.durationSec;
	}
	return payload;
}
