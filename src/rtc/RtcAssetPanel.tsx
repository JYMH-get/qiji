/**
 * RtcAssetPanel —— 实时剪辑（第三模式）左栏面板（分页版，参考剪映）。
 *
 * 结构（用户定稿）：
 *  - 顶部**五分页**（红框位置）：素材 / 资产 / 转场 / 字幕 / 特效；
 *  - 左缘**二级分类竖栏**（绿框位置，参考剪映左列）：
 *      素材页 = 视频 / 音频 / 图片 / 收藏 / 共享（视频=本分集分镜成片∪素材库、图片=本地导入图）；
 *      资产页 = 角色 / 场景 / 生物 / 群像 / 道具（项目五类，选中出图语义不变）；
 *      转场 / 字幕 / 特效页无竖栏（内容独占）。
 *  - **分集过滤**（防素材堆积卡顿）：素材页的 分镜成片=只列当前分集、素材库=当前分集导入的 +
 *    未打分集标记的旧素材；「本地导入」给新素材打当前分集标记。
 *  - 转场页：18 条剪映内置转场卡（lib/jyTransitions）——点击=应用到时间轴选中的视频片段
 *    （挂片段尾部、与下一段衔接；与属性面板转场下拉同一字段 transitionAfter，导出剪映后生效）；
 *  - 字幕页：「＋在播放头添加字幕」 + 现有字幕列表（点行=选中并跳到该字幕，正文在右栏编辑）；
 *  - 特效页：占位（导出剪映后可在剪映里加特效）。
 *
 * 数据读取/拖拽/选中语义与旧版完全一致（AssetAssistant 同源只读；HTML5 MIME 拖拽硬契约；
 * 项目五类卡选中→右栏出图、媒体卡选中→中栏预览、右键选造型、双击灯箱、音频试听）。
 * 红线：绝不存 base64；本面板不发起任何生成请求（资产出图收口在 panel/assetGenActions 唯一路径）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Upload, Plus } from "lucide-react";
import { useProjectStore, resolveEpisodeKey } from "@/store/projectStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useFavoritesStore } from "@/store/favoritesStore";
import { useSharedLibStore, type CachedSharedAsset } from "@/store/sharedLibStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { openLightbox } from "@/store/lightboxStore";
import { saveRemoteAsset } from "@/services/assetPersist";
import { uploadMediaToCanvasAsset, uploadKindFromFile } from "@/canvas/nodeUpload";
import {
	buildAssetPayload, isAssetCat, filterByQuery, filterLibraryByEpisode, buildCanvasAssetEpisodeMap,
	collectProjectImageItems, collectLibraryImageItems, collectVideoItems, collectAudioItems,
	collectFavoriteItems, collectSharedFolderItems,
	type RtcAssetItem,
} from "./asset/rtcAssetData";
import { useCanvasStore } from "@/store/canvasStore";
import { RtcAssetCard } from "./asset/RtcAssetCard";
import { useRtcAssetSelStore } from "./rtcAssetSelStore";
import { useRtcStore, activeRtcDoc } from "@/store/rtcStore";
import type { AssetCat } from "@/store/projectStore";
import { JY_PREVIEW_TRANSITIONS, findJyTransition } from "@/lib/jyTransitions";
import { commitSegmentPatch, fmtUs } from "./panel/rtcSegUtils";
import { addSubtitleAtPlayhead } from "./textActions";

const ACCENT = "#8b5cf6";

function isTauriEnv(): boolean {
	return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** 共享素材登记进三元映射（与 AssetAssistant ensureSharedBlob 同逻辑；原函数未导出，按约定复制实现）——
 *  拖拽/入轨后 drop 端凭 blobByUri 解析公网 url，完全复用既有流程 */
function ensureSharedBlob(rec: CachedSharedAsset): void {
	if (!rec.url || !rec.localUri) return;
	useProjectStore.getState().registerAssetBlob({
		id: rec.assetId || rec.id, url: rec.url, srcUri: rec.localUri,
		localPath: rec.localPath, localUri: rec.localUri, mime: rec.mime,
	});
}

/* ── 分页 / 二级分类定义 ── */

type RtcPage = "media" | "assets" | "transitions" | "subtitles" | "effects";
const PAGES: Array<{ v: RtcPage; label: string }> = [
	{ v: "media", label: "素材" },
	{ v: "assets", label: "资产" },
	{ v: "transitions", label: "转场" },
	{ v: "subtitles", label: "字幕" },
	{ v: "effects", label: "特效" },
];

type MediaRail = "videos" | "audios" | "images" | "favorite" | "shared";
const MEDIA_RAILS: Array<{ v: MediaRail; label: string }> = [
	{ v: "videos", label: "视频" },
	{ v: "audios", label: "音频" },
	{ v: "images", label: "图片" },
	{ v: "favorite", label: "收藏" },
	{ v: "shared", label: "共享" },
];
const ASSET_RAILS: Array<{ v: AssetCat; label: string }> = [
	{ v: "characters", label: "角色" },
	{ v: "scenes", label: "场景" },
	{ v: "organisms", label: "生物" },
	{ v: "crowds", label: "群像" },
	{ v: "items", label: "道具" },
];

/** 二级分类竖栏（绿框位置，参考剪映左列） */
function Rail<T extends string>({ items, active, onPick }: { items: Array<{ v: T; label: string }>; active: T; onPick: (v: T) => void }) {
	return (
		<div style={{ width: 52, flexShrink: 0, display: "flex", flexDirection: "column", gap: 3, padding: "8px 5px", borderRight: "1px solid rgba(255,255,255,0.06)", overflowY: "auto" }}>
			{items.map((it) => (
				<button key={it.v} onClick={() => onPick(it.v)}
					style={{ padding: "7px 0", fontSize: 11, borderRadius: 6, cursor: "pointer", border: "none", background: active === it.v ? "rgba(139,92,246,0.18)" : "transparent", color: active === it.v ? "#c4b5fd" : "rgba(255,255,255,0.55)", fontWeight: active === it.v ? 600 : 400 }}>
					{it.label}
				</button>
			))}
		</div>
	);
}

export function RtcAssetPanel() {
	const [page, setPageRaw] = useState<RtcPage>("media");
	const [mediaRail, setMediaRail] = useState<MediaRail>("videos");
	const [assetRail, setAssetRail] = useState<AssetCat>("characters");
	const [q, setQ] = useState("");
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	// 共享栏两级导航（参考资产助手：库 → 文件夹 → 素材，不摊平全显示）
	const [sharedLibId, setSharedLibId] = useState<string | null>(null);
	const [sharedFolderId, setSharedFolderId] = useState<string | null>(null);
	const [importing, setImporting] = useState(false);
	const [toast, setToast] = useState("");
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const showToast = (m: string) => {
		setToast(m);
		if (toastTimer.current) clearTimeout(toastTimer.current);
		toastTimer.current = setTimeout(() => setToast(""), 4000);
	};
	// 右键「选择造型」菜单（与 AssetAssistant 同规：造型=主体卡的副资产，不单独成卡）
	const [formMenu, setFormMenu] = useState<{ x: number; y: number; item: RtcAssetItem } | null>(null);
	const setPage = (p: RtcPage) => { setPageRaw(p); setSelectedKey(null); setFormMenu(null); setSharedLibId(null); setSharedFolderId(null); };

	// ── 数据源（与 AssetAssistant 同源；逐字段订阅限制重渲染范围） ──
	const characters = useProjectStore((s) => s.characters);
	const scenes = useProjectStore((s) => s.scenes);
	const organisms = useProjectStore((s) => s.organisms);
	const crowds = useProjectStore((s) => s.crowds);
	const propItems = useProjectStore((s) => s.items);
	const episodes = useProjectStore((s) => s.episodes);
	const rtcEpisodeId = useProjectStore((s) => s.rtcEpisodeId);
	const assetBlobs = useProjectStore((s) => s.assetBlobs);
	const selForm = useAssetFormStore((s) => s.selForm);
	const libAssetsMap = useLibraryStore((s) => s.assets);
	const favServerItems = useFavoritesStore((s) => s.items);
	const sharedLibs = useSharedLibStore((s) => s.libs);
	const foldersByLib = useSharedLibStore((s) => s.foldersByLib);
	const assetsByFolder = useSharedLibStore((s) => s.assetsByFolder);
	// 跨面板共享的「项目资产」选中态（右栏资产属性视图数据源）+ 出图在途（卡片角标）
	const assetSel = useRtcAssetSelStore((s) => s.selected);
	const mediaSel = useRtcAssetSelStore((s) => s.mediaSel);
	const pendingGens = useProjectStore((s) => s.pendingGens);
	const generatingKeys = useMemo(() => {
		const set = new Set<string>();
		for (const p of pendingGens) if (p.status === "running" && p.cat && p.assetId) set.add(`${p.cat}:${p.assetId}`);
		return set;
	}, [pendingGens]);

	// 当前激活分集（素材页分集过滤 + 本地导入打标）
	const epKey = resolveEpisodeKey(rtcEpisodeId, episodes);
	const activeEpisode = episodes.find((e) => e.id === epKey);

	const libAssets = useMemo(() => Object.values(libAssetsMap), [libAssetsMap]);
	// 画布生成物 → 分集归属反查表（用户定稿「画布生成物也加进来」：每分集一块画布，画布产物=该集产物；
	// 新生成的产物 addAsset 时已打 episodeId，反查表覆盖打标机制之前的存量）
	const canvases = useProjectStore((s) => s.canvases);
	const canvasEpisodeId = useProjectStore((s) => s.canvasEpisodeId);
	const canvasNodes = useCanvasStore((s) => s.nodes);
	const assetEpMap = useMemo(
		() => buildCanvasAssetEpisodeMap(canvases, resolveEpisodeKey(canvasEpisodeId, episodes), canvasNodes),
		[canvases, canvasEpisodeId, episodes, canvasNodes],
	);
	// 素材页的素材库口径：本地导入 + 画布生成物，一律按当前分集过滤（打标/画布归属命中本集，
	// 或两处都查不到归属的旧素材）——分镜成片走 shots 自有渠道天然按集
	const epLibAssets = useMemo(
		() => filterLibraryByEpisode(libAssets, epKey, assetEpMap),
		[libAssets, epKey, assetEpMap],
	);
	// blobByUri 快照版：与 projectStore.blobByUri 同判据（localUri/url/srcUri），随 assetBlobs 变化重建
	const blobByUri = useMemo(() => {
		const all = Object.values(assetBlobs);
		return (uri: string) => all.find((b) => b.localUri === uri || b.url === uri || b.srcUri === uri);
	}, [assetBlobs]);

	// 共享缓存初始化（读应用级缓存文件；素材「获取」入口仍在资产助手）
	useEffect(() => { void useSharedLibStore.getState().init(); }, []);
	// 收藏：切到收藏栏时从服务端拉一次（收藏是跨机的，本地不留权威副本）
	const onFavRail = page === "media" && mediaRail === "favorite";
	useEffect(() => { if (onFavRail) void useFavoritesStore.getState().load(); }, [onFavRail]);
	// 跨设备收藏（本机无副本）：后台按 assetId 拉一份落三元映射，卡片随之自动换源（与助手同逻辑：
	// 逐个串行、失败跳过——收藏墙不该为了显示把网络打满）
	useEffect(() => {
		if (!onFavRail || !isTauriEnv()) return;
		let cancelled = false;
		void (async () => {
			for (const f of favServerItems) {
				if (cancelled) break;
				if (!f.url || useProjectStore.getState().assetBlobs[f.assetId]?.localUri) continue;
				const b = await saveRemoteAsset(f.assetId, f.url).catch(() => null);
				if (!cancelled && b) useProjectStore.getState().registerAssetBlob({ ...b, srcUri: f.url });
			}
		})();
		return () => { cancelled = true; };
	}, [onFavRail, favServerItems]);

	// ── 分类汇集（纯函数层；素材页按当前分集过滤——防素材堆积卡顿） ──
	const gridItems = useMemo<RtcAssetItem[]>(() => {
		if (page === "assets") {
			const arr = assetRail === "characters" ? characters : assetRail === "scenes" ? scenes : assetRail === "organisms" ? organisms : assetRail === "crowds" ? crowds : propItems;
			// placeholders=true：无图资产（拆分刚提取）以占位符卡排最前——搜索/计数天然把它们算上
			return collectProjectImageItems(arr, assetRail, selForm, { placeholders: true });
		}
		if (page !== "media") return [];
		if (mediaRail === "videos") {
			// 分镜成片只列**当前分集**（分集化核心：别的集的成片在别的集的素材页）
			return collectVideoItems(activeEpisode ? [activeEpisode] : [], epLibAssets, blobByUri);
		}
		if (mediaRail === "audios") return collectAudioItems([...characters, ...scenes, ...organisms, ...crowds, ...propItems], epLibAssets, blobByUri);
		if (mediaRail === "images") return collectLibraryImageItems(epLibAssets, { includeGenerated: true });
		if (mediaRail === "favorite") return collectFavoriteItems(favServerItems, assetBlobs);
		// 共享：按 库→文件夹 层级浏览（参考资产助手，不摊平全显示）——进到具体文件夹才出素材网格
		return sharedFolderId ? collectSharedFolderItems(assetsByFolder[sharedFolderId] ?? []) : [];
	}, [page, mediaRail, assetRail, characters, scenes, organisms, crowds, propItems, activeEpisode, epLibAssets, blobByUri, selForm, favServerItems, assetBlobs, assetsByFolder, sharedFolderId]);

	const shown = useMemo(() => filterByQuery(gridItems, q), [gridItems, q]);

	// ── 音频试听（单例：同时只播一条，切换即停旧的） ──
	const [playingKey, setPlayingKey] = useState<string | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const togglePlay = (item: RtcAssetItem) => {
		if (playingKey === item.key) {
			audioRef.current?.pause();
			setPlayingKey(null);
			return;
		}
		if (!audioRef.current) audioRef.current = new Audio();
		const a = audioRef.current;
		a.src = item.uri;
		a.onended = () => setPlayingKey(null);
		void a.play().catch(() => setPlayingKey(null));
		setPlayingKey(item.key);
	};
	useEffect(() => () => { audioRef.current?.pause(); }, []);

	// ── 拖拽（恒 HTML5 MIME——时间轴/右栏 drop 端的契约） ──
	const onDragStart = (e: React.DragEvent, item: RtcAssetItem) => {
		if (item.placeholder) { e.preventDefault(); return; } // 占位符无图无媒体：不进拖拽体系（卡片已 draggable=false，双保险）
		if (item.sharedRec) ensureSharedBlob(item.sharedRec); // 先登记：drop 端才能凭 blobByUri 解析公网 url
		const st = useProjectStore.getState();
		const blob = st.blobByUri(item.uri) || (item.id ? st.assetBlobs[item.id] : undefined);
		const payload = JSON.stringify(buildAssetPayload(item, blob));
		e.dataTransfer.setData("application/x-qiji-asset", payload);
		e.dataTransfer.setData("text/plain", payload);
		e.dataTransfer.effectAllowed = "copyMove";
	};

	const onPreview = (item: RtcAssetItem) => {
		if (item.placeholder) return; // 占位符无图可看（双击不开灯箱；点击选中已在右栏引导出图）
		openLightbox({ uri: item.uri, name: item.name, media: item.media, voiceUri: item.voiceUri, voiceName: item.voiceName });
	};

	// ── 右键「选择造型」（仅资产页、>1 个已出图造型才弹；选中造型写 assetFormStore——与资产助手互通） ──
	const onCardContextMenu = (e: React.MouseEvent, item: RtcAssetItem) => {
		if (page !== "assets" || !item.id || !isAssetCat(item.cat) || (item.forms?.length ?? 0) <= 1) return;
		e.preventDefault();
		setFormMenu({ x: e.clientX, y: e.clientY, item });
	};

	// ── 卡片选中 ──
	// 资产页五类卡：选中态进跨面板共享 store（右栏资产属性视图 + 中栏主图预览）；
	// 素材页「视频/音频」媒体卡（收藏/共享除外）：选中态进同 store 的 mediaSel（中栏预览；两类互斥）；
	// 其余卡（收藏/共享/图片）保持本地高亮。均「再点已选中的卡 = 取消选中」。
	const onSelectCard = (item: RtcAssetItem) => {
		if (page === "assets" && item.id && isAssetCat(item.cat)) {
			const st = useRtcAssetSelStore.getState();
			const same = !!st.selected && st.selected.cat === item.cat && st.selected.id === item.id;
			st.toggle({ cat: item.cat, id: item.id });
			// 新选中时清时间轴片段选中——右栏立即切到资产视图（片段视图优先级更高）
			if (!same) useRtcStore.getState().setSelection([]);
			setSelectedKey(null);
			return;
		}
		if (page === "media" && item.uri) {
			// 素材页各栏（视频/音频/图片/收藏/共享）点击一律进中栏预览（用户定稿：图片/收藏/共享也要预览）
			useRtcAssetSelStore.getState().toggleMedia({ key: item.key, uri: item.uri, media: item.media, name: item.name });
			setSelectedKey(null);
			return;
		}
		setSelectedKey((k) => (k === item.key ? null : item.key));
	};
	const cardSelected = (it: RtcAssetItem): boolean => {
		if (page === "assets" && !!it.id && isAssetCat(it.cat)) return !!assetSel && assetSel.cat === it.cat && assetSel.id === it.id;
		if (page === "media") return mediaSel?.key === it.key;
		return selectedKey === it.key;
	};
	const cardGenerating = (it: RtcAssetItem): boolean =>
		page === "assets" && !!it.id && isAssetCat(it.cat) && generatingKeys.has(`${it.cat}:${it.id}`);

	// ── 本地导入（懒上传：LC- 本地资产零网络；ensurePublicUrl 提交时统一补传；打当前分集标记） ──
	const doImport = () => {
		if (importing) return;
		const input = document.createElement("input");
		input.type = "file";
		input.multiple = true;
		input.accept = "image/*,video/*,audio/*";
		input.onchange = async () => {
			const files = Array.from(input.files ?? []);
			if (!files.length) return;
			setImporting(true);
			let done = 0;
			let firstRail: MediaRail | null = null;
			try {
				for (const f of files) {
					const kind = uploadKindFromFile(f);
					if (kind === "script") continue; // 仅媒体文件（选择器 accept 已限定，双保险）
					try {
						const up = await uploadMediaToCanvasAsset(f);
						useLibraryStore.getState().addAsset({
							id: up.assetId, kind, name: f.name.replace(/\.[^.]+$/, ""), uri: up.displayUri,
							serverAssetId: up.assetId, thumbnailUri: kind === "image" ? up.displayUri : null,
							createdAt: new Date().toISOString(), deletedByUser: false, localPath: up.localPath,
							origin: "upload",
							episodeId: epKey || null, // 分集化：导入归当前分集（素材页按分集过滤）
						});
						done++;
						if (!firstRail) firstRail = kind === "video" ? "videos" : kind === "audio" ? "audios" : "images";
					} catch (err) {
						showToast(`导入失败：${f.name}（${err instanceof Error ? err.message : "未知错误"}）`);
					}
				}
			} finally {
				setImporting(false);
			}
			if (done > 0) {
				showToast(`已导入 ${done} 个素材到「${activeEpisode?.title ?? "当前分集"}」（提交请求时自动上传云端）`);
				setPageRaw("media");
				if (firstRail) setMediaRail(firstRail);
			}
		};
		input.click();
	};

	const emptyText = page === "assets"
		? "该分类暂无资产——在「AI 生成」工作台做资产拆分后，提取的资产会以占位符卡显示（选中后在右栏生成图片）"
		: mediaRail === "favorite"
			? "暂无收藏，在资产助手点资产卡的 ☆ 收藏"
			: mediaRail === "shared"
				? "该文件夹暂无已下载素材——在资产助手「共享资产」里对它「获取」下载后即可在此使用"
				: mediaRail === "videos" ? "本分集暂无视频：分镜生成成片或点「本地导入」添加视频文件"
					: mediaRail === "audios" ? "本分集暂无音频：给资产绑定音色或点「本地导入」添加音频文件"
						: "本分集暂无图片：点「本地导入」把本地图片登记进素材库";

	/* ── 转场页 / 字幕页 的数据 ── */
	const selection = useRtcStore((s) => s.selection);
	const rtcDoc = useRtcStore(activeRtcDoc);
	/** 转场目标 = 选中片段里第一个位于视频轨的 媒体/复合 片段（转场仅视频轨有意义，与属性面板同规） */
	const transitionTarget = useMemo(() => {
		if (!rtcDoc || selection.length === 0) return null;
		for (const t of rtcDoc.tracks) {
			if (t.type !== "video") continue;
			const seg = t.segments.find((s) => selection.includes(s.id) && (s.kind === "media" || s.kind === "compound"));
			if (seg) return seg;
		}
		return null;
	}, [rtcDoc, selection]);
	const applyTransition = (effectId: string) => {
		if (!transitionTarget) return;
		if (!effectId) {
			if (transitionTarget.transitionAfter) commitSegmentPatch(transitionTarget.id, { transitionAfter: undefined });
			return;
		}
		const meta = findJyTransition(effectId);
		if (!meta || transitionTarget.transitionAfter?.effectId === effectId) return;
		commitSegmentPatch(transitionTarget.id, {
			transitionAfter: { effectId: meta.effectId, resourceId: meta.resourceId, name: meta.name, durationUs: meta.defaultDurationUs },
		});
	};
	/** 字幕列表：当前编辑层全部 text 轨片段（按起点升序） */
	const subtitleSegs = useMemo(() => {
		if (!rtcDoc) return [];
		const out: Array<{ id: string; startUs: number; content: string }> = [];
		for (const t of rtcDoc.tracks) {
			if (t.type !== "text") continue;
			for (const s of t.segments) out.push({ id: s.id, startUs: s.targetStartUs, content: s.text?.content || "（空字幕）" });
		}
		return out.sort((a, b) => a.startUs - b.startUs);
	}, [rtcDoc]);

	const searchRow = (
		<div style={{ position: "relative", padding: "8px 10px 0" }}>
			<Search size={12} style={{ position: "absolute", left: 20, top: 16, color: "rgba(255,255,255,0.35)", pointerEvents: "none" }} />
			<input
				value={q}
				onChange={(e) => setQ(e.target.value)}
				placeholder="按名称搜索"
				style={{ width: "100%", padding: "5px 10px 5px 26px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.05)", color: "#fff", outline: "none" }} />
		</div>
	);

	const cardGrid = (
		<div style={{ flex: 1, overflowY: "auto", padding: "10px 10px" }}>
			{shown.length === 0 ? (
				<div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, textAlign: "center", padding: "44px 10px", lineHeight: 1.7 }}>
					{q.trim() ? "没有匹配的素材" : emptyText}
				</div>
			) : (
				// 自适应列数：面板拖宽自动增列、拖窄减列，卡片保持 ~96–130px（密度对齐资产助手）
				<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 7 }}>
					{shown.map((it) => (
						<RtcAssetCard
							key={it.key}
							item={it}
							selected={cardSelected(it)}
							generating={cardGenerating(it)}
							playing={playingKey === it.key}
							onSelect={onSelectCard}
							onDragStart={onDragStart}
							onPreview={onPreview}
							onTogglePlay={it.media === "audio" ? togglePlay : undefined}
							onContextMenu={page === "assets" ? onCardContextMenu : undefined}
						/>
					))}
				</div>
			)}
		</div>
	);

	return (
		<aside className="w-[300px] shrink-0 flex flex-col min-h-0 bg-secondary/20 border-r border-white/5">
			{/* 顶部五分页（红框位置，参考剪映顶排）+ 本地导入（仅素材页） */}
			<div style={{ display: "flex", alignItems: "center", gap: 3, padding: "8px 10px 8px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
				{PAGES.map((p) => (
					<button key={p.v} onClick={() => setPage(p.v)}
						style={{ flex: 1, padding: "5px 0", fontSize: 12, borderRadius: 6, cursor: "pointer", border: "1px solid " + (page === p.v ? ACCENT : "transparent"), background: page === p.v ? "rgba(139,92,246,0.15)" : "transparent", color: page === p.v ? "#c4b5fd" : "rgba(255,255,255,0.6)", fontWeight: page === p.v ? 600 : 400 }}>
						{p.label}
					</button>
				))}
			</div>

			{toast && (
				<div style={{ margin: "8px 10px 0", padding: "5px 9px", borderRadius: 6, fontSize: 11, background: "rgba(139,92,246,0.14)", color: "#c4b5fd" }}>
					{toast}
				</div>
			)}

			{/* ── 素材 / 资产：竖栏二级分类 + 搜索 + 卡片网格 ── */}
			{(page === "media" || page === "assets") && (
				<div style={{ flex: 1, minHeight: 0, display: "flex" }}>
					{page === "media"
						? <Rail items={MEDIA_RAILS} active={mediaRail} onPick={(v) => { setMediaRail(v); setSelectedKey(null); setSharedLibId(null); setSharedFolderId(null); }} />
						: <Rail items={ASSET_RAILS} active={assetRail} onPick={(v) => { setAssetRail(v); setSelectedKey(null); setFormMenu(null); }} />}
					<div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
						{page === "media" && mediaRail !== "shared" && (
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px 0" }}>
								<span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)" }} title="素材页按分集显示（分集三模同步）：本集分镜成片 + 本集导入素材 + 本集画布上生成的产物；查不到归属的旧素材各集都显示">
									分集：{activeEpisode?.title ?? "—"}
								</span>
								<button
									onClick={doImport}
									disabled={importing}
									title={`导入本地图片/视频/音频到素材库并归入「${activeEpisode?.title ?? "当前分集"}」（本地暂存零等待；提交生成/导出请求时自动上传云端）`}
									style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", fontSize: 11, borderRadius: 6, cursor: importing ? "wait" : "pointer", border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.85)", opacity: importing ? 0.6 : 1 }}>
									<Upload size={11} /> {importing ? "导入中…" : "本地导入"}
								</button>
							</div>
						)}
						{page === "media" && mediaRail === "shared" ? (
							/* 共享：库 → 文件夹 → 素材 两级导航（参考资产助手，不摊平全显示——太乱） */
							<>
								<div style={{ display: "flex", alignItems: "center", gap: 4, padding: "8px 10px 0", fontSize: 11, color: "rgba(255,255,255,0.55)", flexWrap: "wrap" }}>
									<span
										onClick={() => { setSharedLibId(null); setSharedFolderId(null); }}
										style={{ cursor: "pointer", color: sharedLibId ? "#c4b5fd" : "rgba(255,255,255,0.8)" }}>
										共享库
									</span>
									{sharedLibId && (
										<>
											<span style={{ color: "rgba(255,255,255,0.3)" }}>/</span>
											<span
												onClick={() => setSharedFolderId(null)}
												style={{ cursor: "pointer", color: sharedFolderId ? "#c4b5fd" : "rgba(255,255,255,0.8)", maxWidth: 90, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
												{sharedLibs.find((l) => l.id === sharedLibId)?.name ?? "库"}
											</span>
										</>
									)}
									{sharedFolderId && (
										<>
											<span style={{ color: "rgba(255,255,255,0.3)" }}>/</span>
											<span style={{ color: "rgba(255,255,255,0.8)", maxWidth: 90, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
												{(foldersByLib[sharedLibId ?? ""] ?? []).find((f) => f.id === sharedFolderId)?.name ?? "文件夹"}
											</span>
										</>
									)}
								</div>
								{sharedFolderId ? (
									<>
										{searchRow}
										{cardGrid}
									</>
								) : sharedLibId ? (
									<div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
										{(foldersByLib[sharedLibId] ?? []).length === 0 ? (
											<div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, textAlign: "center", padding: "36px 10px", lineHeight: 1.7 }}>
												该库还没有获取文件夹清单——到资产助手「共享资产」页对它「获取」后即可在此浏览
											</div>
										) : (
											(foldersByLib[sharedLibId] ?? []).map((f) => {
												const downloaded = (assetsByFolder[f.id] ?? []).filter((r) => r.localUri).length;
												return (
													<div key={f.id}
														onClick={() => setSharedFolderId(f.id)}
														style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 10px", marginBottom: 5, borderRadius: 7, cursor: "pointer", border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}>
														<span style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>📁 {f.name}</span>
														<span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>{f.count} 素材 · 已下载 {downloaded}</span>
													</div>
												);
											})
										)}
									</div>
								) : (
									<div style={{ flex: 1, overflowY: "auto", padding: "8px 10px" }}>
										{sharedLibs.length === 0 ? (
											<div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, textAlign: "center", padding: "36px 10px", lineHeight: 1.7 }}>
												尚未加入任何共享库——在资产助手「共享资产」里按名称搜索、凭加入密码加入后即可在此浏览
											</div>
										) : (
											sharedLibs.map((l) => (
												<div key={l.id}
													onClick={() => setSharedLibId(l.id)}
													style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 10px", marginBottom: 5, borderRadius: 7, cursor: "pointer", border: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.03)" }}>
													<span style={{ fontSize: 12, color: "rgba(255,255,255,0.85)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>🗂 {l.name}</span>
													<span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", flexShrink: 0 }}>{l.folderCount} 夹 · {l.assetCount} 素材</span>
												</div>
											))
										)}
									</div>
								)}
							</>
						) : (
							<>
								{searchRow}
								{cardGrid}
							</>
						)}
					</div>
				</div>
			)}

			{/* ── 转场页：18 条剪映内置转场（点击应用到选中的视频片段尾部） ── */}
			{page === "transitions" && (
				<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
					<div style={{ padding: "8px 12px 0", fontSize: 11, lineHeight: 1.6, color: transitionTarget ? "rgba(255,255,255,0.6)" : "#fbbf24" }}>
						{transitionTarget
							? <>应用到选中片段「{transitionTarget.name || "片段"}」尾部（与下一段衔接）{transitionTarget.transitionAfter ? ` · 当前：${transitionTarget.transitionAfter.name}` : ""}</>
							: "先在时间轴选中一个视频片段，再点转场应用（挂片段尾部、与下一段衔接）"}
					</div>
					<div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
						<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(76px, 1fr))", gap: 7 }}>
							<button
								onClick={() => applyTransition("")}
								disabled={!transitionTarget}
								title="移除选中片段的转场"
								style={{ aspectRatio: "4/3", borderRadius: 8, cursor: transitionTarget ? "pointer" : "not-allowed", fontSize: 11.5, border: "1px solid " + (transitionTarget && !transitionTarget.transitionAfter ? ACCENT : "rgba(255,255,255,0.12)"), background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.7)", opacity: transitionTarget ? 1 : 0.45 }}>
								无
							</button>
							{JY_PREVIEW_TRANSITIONS.map((t) => {
								const active = transitionTarget?.transitionAfter?.effectId === t.effectId;
								return (
									<button key={t.effectId}
										onClick={() => applyTransition(t.effectId)}
										disabled={!transitionTarget}
										title={`${t.name}（默认 ${(t.defaultDurationUs / 1_000_000).toFixed(1)}s，可在右栏属性面板改时长；预览与导出剪映观感一致）`}
										style={{ aspectRatio: "4/3", borderRadius: 8, cursor: transitionTarget ? "pointer" : "not-allowed", fontSize: 11.5, border: "1px solid " + (active ? ACCENT : "rgba(255,255,255,0.12)"), background: active ? "rgba(139,92,246,0.18)" : "rgba(255,255,255,0.04)", color: active ? "#c4b5fd" : "rgba(255,255,255,0.75)", opacity: transitionTarget ? 1 : 0.45 }}>
										{t.name}
									</button>
								);
							})}
						</div>
					</div>
					<div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", padding: "7px 12px", borderTop: "1px solid rgba(255,255,255,0.06)", lineHeight: 1.5 }}>
						预览播放器渲染转场真效果（所见即所得，与剪映一致）；只提供能预览的基础转场，时长在右栏属性面板可调
					</div>
				</div>
			)}

			{/* ── 字幕页：添加 + 现有字幕列表（正文在右栏编辑） ── */}
			{page === "subtitles" && (
				<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
					<div style={{ padding: "10px 12px 0" }}>
						<button
							onClick={() => addSubtitleAtPlayhead()}
							style={{ display: "flex", alignItems: "center", gap: 5, width: "100%", justifyContent: "center", padding: "7px 0", fontSize: 12, borderRadius: 7, cursor: "pointer", border: "1px solid rgba(139,92,246,0.5)", background: "rgba(139,92,246,0.14)", color: "#c4b5fd" }}>
							<Plus size={13} /> 在播放头位置添加字幕
						</button>
					</div>
					<div style={{ flex: 1, overflowY: "auto", padding: "10px 12px" }}>
						{subtitleSegs.length === 0 ? (
							<div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, textAlign: "center", padding: "36px 10px", lineHeight: 1.7 }}>
								暂无字幕——点上方按钮在播放头添加，或在时间轴 text 轨空白处双击
							</div>
						) : (
							subtitleSegs.map((s) => (
								<div key={s.id}
									onClick={() => {
										useRtcStore.getState().setSelection([s.id]);
										useRtcStore.getState().setPlayhead(s.startUs);
									}}
									title="点击选中该字幕并跳到其起点（正文与样式在右栏属性面板编辑）"
									style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", marginBottom: 4, borderRadius: 6, cursor: "pointer", border: "1px solid " + (selection.includes(s.id) ? ACCENT : "rgba(255,255,255,0.08)"), background: selection.includes(s.id) ? "rgba(139,92,246,0.12)" : "rgba(255,255,255,0.03)" }}>
									<span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.45)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{fmtUs(s.startUs)}</span>
									<span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.85)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{s.content}</span>
								</div>
							))
						)}
					</div>
					<div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", padding: "7px 12px", borderTop: "1px solid rgba(255,255,255,0.06)", lineHeight: 1.5 }}>
						字幕正文/字号/颜色/位置在右栏属性面板编辑 · 导出剪映草稿时落 texts 素材
					</div>
				</div>
			)}

			{/* ── 特效页：占位 ── */}
			{page === "effects" && (
				<div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px 24px" }}>
					<div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, textAlign: "center", lineHeight: 1.8 }}>
						特效功能即将上线（与转场同一原则：<b>预览做得出的才上</b>，所见即所得）
						<br />
						当前可先导出剪映草稿，在剪映中添加特效/滤镜/调节
					</div>
				</div>
			)}

			{/* 底部提示（素材/资产页） */}
			{(page === "media" || page === "assets") && (
				<div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", padding: "7px 12px", borderTop: "1px solid rgba(255,255,255,0.06)", lineHeight: 1.5 }}>
					点击资产 = 右栏出图/中栏预览 · 拖到时间轴 = 入轨 · 拖到右栏垫图区 = 复用 · 双击 = 灯箱 · 右键 = 选造型
				</div>
			)}

			{/* 右键「选择造型」选单（与 AssetAssistant 同规：网格缩略 + 当前造型高亮，点选写 assetFormStore） */}
			{formMenu && (
				<>
					<div onClick={() => setFormMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFormMenu(null); }}
						style={{ position: "fixed", inset: 0, zIndex: 100150 }} />
					<div style={{ position: "fixed", left: Math.min(formMenu.x, window.innerWidth - 232), top: Math.min(formMenu.y, window.innerHeight - 240), zIndex: 100151, width: 220, maxHeight: 320, overflowY: "auto", padding: 10, borderRadius: 10, border: "1px solid rgba(255,255,255,0.12)", background: "#181a22", boxShadow: "0 10px 40px rgba(0,0,0,0.6)" }}>
						<div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", marginBottom: 8 }}>选择造型·{formMenu.item.baseName || formMenu.item.name}</div>
						<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
							{(formMenu.item.forms ?? []).map((f, i) => {
								const active = (f.variantId ?? null) === (formMenu.item.variantId ?? null);
								return (
									<div key={i} title={f.label + (active ? "（当前）" : "")}
										onClick={() => { if (formMenu.item.id) useAssetFormStore.getState().setSelForm(formMenu.item.id, f.variantId ?? null); setFormMenu(null); }}
										style={{ position: "relative", aspectRatio: "1/1", borderRadius: 6, overflow: "hidden", cursor: "pointer", border: "2px solid " + (active ? ACCENT : "rgba(255,255,255,0.12)"), background: `center/cover no-repeat url(${f.uri})` }}>
										{active && <span style={{ position: "absolute", inset: 0, background: "rgba(139,92,246,0.25)" }} />}
										<span style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 9, color: "#fff", background: "rgba(0,0,0,0.6)", padding: "1px 3px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "center" }}>{f.label}</span>
									</div>
								);
							})}
						</div>
					</div>
				</>
			)}
		</aside>
	);
}
