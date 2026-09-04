/**
 * AssetAssistant —— 全局悬浮资产助手（项目大厅外可见）。
 *
 * 悬浮图标可拖动，松手吸附到左/右边缘（位置 localStorage 持久）；点击展开面板。
 * 面板按「大分类（项目/收藏/共享）× 小分类（角色/场景/生物/群像/道具）」浏览资产。
 * 卡片可拖拽：
 *   - 拖到任意「素材区」→ 垫图（payload: application/x-qiji-asset / text/plain JSON）
 *   - 拖到画布 → 新建图片节点（useCanvasDrop 识别 source:"qiji-asset"）
 *   - 拖到软件外 → 复制（DownloadURL，best-effort，需公网/data URL）
 *
 * 注：Tauri 下需 window.dragDropEnabled=false，否则 WebView2 拦截网页内 HTML5 拖拽。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectStore, type AssetCat } from "@/store/projectStore";
import { useFavoritesStore } from "@/store/favoritesStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useCanvasStore } from "@/store/canvasStore";
import { dispatchCommand } from "@/command/dispatch";
import { makeNode, NODE_W, NODE_H } from "@/canvas/nodeFactory";
import { addNodeMaterialFromAsset } from "@/canvas/nodeMaterials";
import { addShotMaterialFromAsset, materialKindFromAssetCat } from "@/lib/shotMaterialOps";
import { usePromptModalStore } from "@/store/promptModalStore";
import { ensureDragThumb, ensureLocalOriginal, saveRemoteAsset } from "@/services/assetPersist";
import { openLightbox } from "@/store/lightboxStore";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { Boxes, ChevronsRight, Star, Volume2 } from "lucide-react";
import { useDockStore, startDockDrag, DOCK_BTN } from "@/store/dockStore";
import { useAssetFormStore } from "@/store/assetFormStore";
import { runAssetCheck, uriCheckTargets, allProjectAssetTargets } from "@/services/assetCheck";
import { ShieldCheck, RefreshCw, FolderPlus, Share2, ChevronLeft, Folder, LogIn, Upload, Link2 } from "lucide-react";
import AssetBindModal from "@/components/AssetBindModal";
import { useSharedLibStore, type CachedSharedAsset } from "@/store/sharedLibStore";
import { managedClient } from "@/services/managedClient";
import { sharedItemFromUri } from "@/services/sharedPublish";
import { openSharedPick } from "@/store/sharedPickStore";
import { confirmDialog } from "@/lib/confirmDialog";
import type { SharedLibraryInfo } from "@/contract";

function isTauriEnv(): boolean {
	return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

type Major = "project" | "favorite" | "shared";
/** 助手分类 = 项目五类 + 「其他」兜底（项目数据模型暂无其他桶=空态；共享素材按台账 id 前缀分入） */
type SubCat = AssetCat | "others";
/** 一个「造型」（基础形象或某变体）——副资产，右击切换 */
interface AssetForm { variantId: string | null; label: string; name: string; uri: string; images?: string[] }
interface AssetItem { uri: string; name: string; cat: SubCat; id?: string; variantId?: string | null; images?: string[];
	/** 该资产的基础名（菜单标题用） */
	baseName?: string;
	/** 该资产的全部造型（基础+变体，仅含已出图）——供右击「选择造型」 */
	forms?: AssetForm[];
	/** 该资产绑定的音色（第114轮：卡片右下角音频标点击播放；放大灯箱显示绑定提示） */
	voiceUri?: string;
	voiceName?: string }

const MAJORS: Array<{ v: Major; label: string }> = [
	{ v: "project", label: "项目资产" },
	{ v: "favorite", label: "收藏资产" },
	{ v: "shared", label: "共享资产" },
];
const SUBS: Array<{ v: SubCat; label: string }> = [
	{ v: "characters", label: "角色" },
	{ v: "scenes", label: "场景" },
	{ v: "organisms", label: "生物" },
	{ v: "crowds", label: "群像" },
	{ v: "items", label: "道具" },
	{ v: "others", label: "其他" },
];

/** 共享素材分类：按台账资产 id 前缀（id 是真理）——C/A 角色、G 群像、M 生物、S 场景、P 道具，其余（TP/video/audio/无 id）=其他 */
/** 配额显示：MB/GB 两档就够（收藏额度是百 MB 到几 GB 量级） */
function fmtMB(n: number): string {
	const mb = n / 1048576;
	return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function sharedCatOf(assetId: string | undefined | null): SubCat {
	const id = assetId || "";
	if (/^[CA]\d/.test(id)) return "characters";
	if (/^G\d/.test(id)) return "crowds";
	if (/^M\d/.test(id)) return "organisms";
	if (/^S\d/.test(id)) return "scenes";
	if (/^P\d/.test(id)) return "items";
	return "others";
}

const FAV_KEY = "Qiji:favoriteAssets";
const PANEL_POS_KEY = "Qiji:assistantPanelPos"; // 展开面板的自由坐标（不吸附边缘）
const PANEL_W = 440;

function loadPanelPos(): { x: number; y: number } | null {
	try { const r = localStorage.getItem(PANEL_POS_KEY); if (r) return JSON.parse(r); } catch { /* ignore */ }
	return null;
}

/**
 * 收藏迁移（P1）：旧收藏是 localStorage 按**显示 uri** 存的，换机即失效、服务端完全不知情。
 * 清理策略上线后「有没有收藏」决定素材是永久保留还是 14 天后消失，这种本地收藏起不到作用，
 * 故改为按 **assetId** 落服务端（useFavoritesStore）。
 * 这里只保留一个一次性迁移：把旧本地收藏的 uri 反查成 assetId 后补传到服务端，然后清掉本地键。
 */
function legacyLocalFavorites(): AssetItem[] {
	try { const r = localStorage.getItem(FAV_KEY); if (r) return JSON.parse(r); } catch { /* ignore */ }
	return [];
}
async function migrateLegacyFavorites(): Promise<number> {
	const old = legacyLocalFavorites();
	if (!old.length) return 0;
	const { blobByUri } = useProjectStore.getState();
	const toggle = useFavoritesStore.getState().toggle;
	const isFav = useFavoritesStore.getState().isFav;
	let done = 0;
	for (const it of old) {
		const id = blobByUri(it.uri)?.id;      // uri → assetId（反查不到的只能放弃：本地收藏本就没记 id）
		if (!id || isFav(id)) continue;
		if (await toggle(id)) done++;          // 超配额会失败——失败的就不迁，用户可手动再收藏
	}
	try { localStorage.removeItem(FAV_KEY); } catch { /* ignore */ }
	return done;
}
/**
 * 卡片拖拽：
 *  - 有本地原件（blob.localPath，Tauri）→ 原生文件拖拽 startDrag：拖出软件外=复制本地原件（不走浏览器
 *    下载、不被拦截）；拖回软件内=文件 drop（落点处理器按文件名 <assetId>.<ext> 解析回 url 快速垫图）。
 *  - 无本地原件 → 退回 HTML5 自定义 MIME（仅软件内垫图/建节点；不再用 DownloadURL 触发被拦截的下载）。
 */
function onCardDragStart(e: React.DragEvent, item: AssetItem) {
	const blob = useProjectStore.getState().blobByUri(item.uri);
	// 有本地原件 → 走原生 OS 文件拖拽：拖到桌面=复制原件；拖回软件内由落点按文件名 <id>.<ext> 解析回 id
	if (isTauriEnv() && blob?.localPath) {
		e.preventDefault(); // 取消浏览器 HTML5 拖拽
		const fullPath = blob.localPath;
		void (async () => {
			// 拖影用降采样小预览（否则插件以原图分辨率渲染，巨大）；复制出去的仍是原件 fullPath
			const icon = (await ensureDragThumb(blob).catch(() => fullPath)) || fullPath;
			await startDrag({ item: [fullPath], icon, mode: "copy" }).catch(() => { });
		})();
		return;
	}
	// 还没有本地原件（无历史/旧数据）：本次走 HTML5（仅软件内可落），同时后台落盘原件，下次即可拖到桌面
	if (isTauriEnv()) void ensureLocalOriginal(item.uri, { name: item.name });
	const url = blob?.url || item.uri;
	const payload = JSON.stringify({
		source: "qiji-asset", assetId: blob?.id, url, localUri: item.uri, localPath: blob?.localPath, name: item.name, kind: "image", cat: item.cat,
	});
	e.dataTransfer.setData("application/x-qiji-asset", payload);
	e.dataTransfer.setData("text/plain", payload);
	e.dataTransfer.effectAllowed = "copyMove";
}

/**
 * 画布模式：用**鼠标拖拽**把资产拖出成「生成图片」节点（与侧边栏 useDragToCanvas 同原理，Tauri 可靠，
 * 不走被 WebView2 拦截的 HTML5/原生拖拽）。资产助手在 ReactFlowProvider 外，故由 viewport + 画布 pane
 * 自行换算 flow 坐标；拖动时实时移动临时节点，松手按命令落定（可撤销）。
 * 仅画布模式生效（DOM 有 .react-flow 时）；非画布模式（资产页素材区/拖出软件）仍走 HTML5（不 preventDefault）。
 */
function startAssetDragToCanvas(e: React.MouseEvent, item: AssetItem): boolean {
	if (e.button !== 0) return false;
	// 提示词放大弹窗打开时：走「仅加垫图」的鼠标拖拽（不建节点），落到弹窗里的素材栏即加垫图。
	const modalOpen = usePromptModalStore.getState().open;
	const pane = document.querySelector(".react-flow") as HTMLElement | null;
	if (!modalOpen && !pane) return false; // 非画布且无弹窗 → 交回 HTML5
	e.preventDefault();
	const blob = useProjectStore.getState().blobByUri(item.uri);
	const assetId = blob?.id || `asset-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
	const ref = blob?.localUri || blob?.url || item.uri;
	// 仅「画布建节点」场景登记库资产（弹窗只加垫图，不建节点、不登记库）
	if (!modalOpen && pane) {
		useLibraryStore.getState().addAsset({
			id: assetId, kind: "image", name: item.name, uri: ref,
			serverAssetId: blob?.id || null, thumbnailUri: ref,
			createdAt: new Date().toISOString(), deletedByUser: false, localPath: blob?.localPath || null,
			origin: "generated", // 资产助手派生 → 不进「本地素材库」
		});
	}
	const toFlow = (cx: number, cy: number) => {
		if (!pane) return { x: 0, y: 0 };
		const r = pane.getBoundingClientRect();
		const vp = useCanvasStore.getState().viewport;
		return { x: (cx - r.left - vp.x) / vp.zoom, y: (cy - r.top - vp.y) / vp.zoom };
	};
	const startX = e.clientX, startY = e.clientY;
	let started = false, createdId: string | null = null, tempNode: ReturnType<typeof makeNode> | null = null;
	const begin = (cx: number, cy: number) => {
		started = true;
		if (modalOpen || !pane) return; // 弹窗模式 / 无画布：不建临时节点，仅松手时加垫图
		const f = toFlow(cx, cy);
		tempNode = makeNode("image.gen", f.x - NODE_W / 2, f.y - NODE_H / 2);
		tempNode.data.resultAssetId = assetId;
		createdId = tempNode.id;
		useCanvasStore.getState().addNode(tempNode); // 临时（不入撤销栈）
	};
	const move = (ev: MouseEvent) => {
		if (!started) { if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 3) begin(ev.clientX, ev.clientY); return; }
		if (createdId) { const f = toFlow(ev.clientX, ev.clientY); useCanvasStore.getState().moveNode(createdId, f.x - NODE_W / 2, f.y - NODE_H / 2); }
	};
	const removeTemp = () => {
		if (!createdId) return;
		const st = useCanvasStore.getState();
		const nodes = { ...st.nodes }; delete nodes[createdId];
		const runtime = { ...st.runtime }; delete runtime[createdId];
		useCanvasStore.setState({ nodes, runtime });
	};
	const up = (ev: MouseEvent) => {
		window.removeEventListener("mousemove", move, true);
		window.removeEventListener("mouseup", up, true);
		if (!started) return;
		const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
		// 落点在画布节点「素材区」→ 加垫图到该节点
		const bayNodeId = el?.closest?.("[data-node-material-bay]")?.getAttribute("data-node-material-bay");
		if (bayNodeId) {
			removeTemp();
			addNodeMaterialFromAsset(bayNodeId, { id: blob?.id, assetId: item.id, url: blob?.url || item.uri, name: item.name, media: "image", usage: materialKindFromAssetCat(item.cat) === "character" ? "identity" : undefined });
			return;
		}
		// 落点在资产模式分镜「素材条」（放大弹窗内）→ 加垫图到该分镜
		const stripKey = el?.closest?.("[data-shot-material-strip]")?.getAttribute("data-shot-material-strip");
		if (stripKey) {
			removeTemp();
			const [epId, shotId] = stripKey.split(":");
			if (epId && shotId) addShotMaterialFromAsset(epId, shotId, { assetId: item.id || blob?.id, uri: ref, name: item.name, media: "image", kind: materialKindFromAssetCat(item.cat) });
			return;
		}
		if (modalOpen) { removeTemp(); return; } // 弹窗模式未落到素材栏 → 不建节点
		if (createdId && tempNode) {
			const fin = useCanvasStore.getState().nodes[createdId];
			const fx = fin ? fin.x : tempNode.x, fy = fin ? fin.y : tempNode.y;
			removeTemp();
			dispatchCommand({ type: "addNode", node: { ...tempNode, x: fx, y: fy } }); // 落定（可撤销）
		}
	};
	window.addEventListener("mousemove", move, true);
	window.addEventListener("mouseup", up, true);
	return true;
}

const panel: React.CSSProperties = { background: "#12151c", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10 };
const accent = "#8b5cf6";

export default function AssetAssistant({ popout = false }: { popout?: boolean }) {
	const [open, setOpen] = useState(false);
	const [major, setMajor] = useState<Major>("project");
	const [sub, setSub] = useState<SubCat>("characters");
	// 收藏（P1）：服务端为准。ids 供 ☆ 状态 O(1) 查询，items 供「收藏资产」页渲染
	const favIds = useFavoritesStore((s) => s.ids);
	const favServerItems = useFavoritesStore((s) => s.items);
	const favQuota = useFavoritesStore((s) => s.quota);
	const favToggle = useFavoritesStore((s) => s.toggle);
	const [favMsg, setFavMsg] = useState("");
	const showToast = (m: string) => { setFavMsg(m); setTimeout(() => setFavMsg(""), 4000); };

	// 悬浮图标位置（与简一助手共用停靠位 dockStore：竖直叠放、同步移动，吸附左/右边缘）
	const { pos, drag } = useDockStore();
	// 提示词放大弹窗(z 100000)打开时，把助手抬到其上方，便于打开助手并拖入垫图
	const promptModalOpen = usePromptModalStore((s) => s.open);
	const zBase = promptModalOpen ? 100100 : 9000;

	// 展开面板拖动（拖标题栏，松手停在原处——展开态不再吸附边缘）
	const [panelDrag, setPanelDrag] = useState<{ x: number; y: number } | null>(null);
	const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(loadPanelPos);
	const panelDragRef = useRef<{ offX: number; offY: number } | null>(null);
	const panelRef = useRef<HTMLDivElement>(null); // 展开面板根（双击外部收起、双击外部判定）

	const cats = useProjectStore((s) => ({ characters: s.characters, scenes: s.scenes, organisms: s.organisms, crowds: s.crowds, items: s.items }));

	// 右键「选择造型」菜单（造型=基础形象的副资产，不再单独成卡）
	const [formMenu, setFormMenu] = useState<{ x: number; y: number; item: AssetItem } | null>(null);

	// 音色试听（第114轮）：卡片右下角音频标点击播放/暂停；同时只播一条，切换即停旧的
	const [playingVoice, setPlayingVoice] = useState<string | null>(null);
	const voiceRef = useRef<HTMLAudioElement | null>(null);
	const toggleVoice = (uri: string) => {
		if (playingVoice === uri) {
			voiceRef.current?.pause();
			setPlayingVoice(null);
			return;
		}
		if (!voiceRef.current) voiceRef.current = new Audio();
		const a = voiceRef.current;
		a.src = uri;
		a.onended = () => setPlayingVoice(null);
		void a.play().catch(() => setPlayingVoice(null));
		setPlayingVoice(uri);
	};
	useEffect(() => () => { voiceRef.current?.pause(); }, []);
	// 每个资产当前选中的造型：assetId → variantId（null=基础形象）；默认基础形象/第一个有图造型。
	// 共享 store：视频界面「提取资产」按此优先取该造型的图作素材。
	const selForm = useAssetFormStore((s) => s.selForm);

	// 一资产一卡：卡片显示「当前选中的造型」，其余造型经右击切换（不再为每个变体平铺单独卡片）
	const projectItems = useMemo(() => {
		const out: AssetItem[] = [];
		// 「其他」：项目数据模型暂无兜底桶 → 空列表（分类仅对共享素材有实际分入）
		for (const a of ((cats as Record<string, any[]>)[sub] ?? [])) {
			const forms: AssetForm[] = [];
			if (a.image) forms.push({ variantId: null, label: "基础形象", name: a.name, uri: a.image, images: a.images });
			for (const v of a.variants ?? []) if (v.image) forms.push({ variantId: v.id, label: v.label || "造型", name: `${a.name}·${v.label || "造型"}`, uri: v.image, images: v.images });
			if (forms.length === 0) continue; // 该资产尚无任何已出图造型 → 不显示
			const sel = a.id ? selForm[a.id] : undefined;
			const cur = forms.find((f) => f.variantId === (sel ?? null)) ?? forms[0];
			out.push({ uri: cur.uri, name: cur.name, cat: sub, id: a.id, variantId: cur.variantId, images: cur.images, baseName: a.name, forms, voiceUri: a.voiceUri, voiceName: a.voiceName });
		}
		return out;
	}, [cats, sub, selForm]);

	// 收藏页：服务端条目 → AssetItem 形态；分类按**台账 id 前缀**（id 是真理，与共享素材同一把尺）。
	// ⚠ 卡片是 `background:url(...)` 直显、不走 useDisplayUri —— **Tauri CSP 不允许 http(s) 图直显**（§9），
	//   所以这里必须按 assetId 现查本地副本优先，公网 url 只作没有本地副本时的占位（下面的 effect 会补下载）。
	const assetBlobs = useProjectStore((s) => s.assetBlobs);
	const favItems = useMemo<AssetItem[]>(
		() => favServerItems
			.filter((f) => sharedCatOf(f.assetId) === sub)
			.map((f) => ({ uri: assetBlobs[f.assetId]?.localUri || f.url, name: f.name || f.assetId, cat: sub, id: f.assetId })),
		[favServerItems, sub, assetBlobs],
	);

	// 跨设备收藏（本机没有副本）：后台按 assetId 拉一份落三元映射，卡片随之自动换源。
	// 逐个串行、失败跳过——收藏墙不该为了显示把网络打满。
	useEffect(() => {
		if (major !== "favorite" || !isTauriEnv()) return;
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
	}, [major, favServerItems]);
	const items = major === "project" ? projectItems : major === "favorite" ? favItems : [];

	// 收藏拉取（P1）：面板打开时从服务端取一次（收藏是跨机的，本地不留权威副本），
	// 并把旧的 localStorage 本地收藏一次性迁上去（反查得到 assetId 的部分）。
	useEffect(() => {
		if (!open) return;
		void (async () => {
			await useFavoritesStore.getState().load();
			const n = await migrateLegacyFavorites();
			if (n > 0) showToast(`已把 ${n} 项本地收藏同步到云端`);
		})();
	}, [open]);

	// 预落盘：为当前展示、尚无本地原件的项目资产后台生成原件，使拖出软件外即时可用（Tauri）
	useEffect(() => {
		if (!isTauriEnv() || !open || major !== "project") return;
		let cancelled = false;
		(async () => {
			for (const it of projectItems) {
				if (cancelled) break;
				if (useProjectStore.getState().blobByUri(it.uri)?.localPath) continue;
				await ensureLocalOriginal(it.uri, { name: it.name }).catch(() => { });
			}
		})();
		return () => { cancelled = true; };
	}, [projectItems, open, major]);

	// 展开时：双击面板以外的区域 → 收起助手（弹出模式为独立窗口，不收起）
	useEffect(() => {
		if (!open || popout) return;
		const onDbl = (e: MouseEvent) => {
			if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("dblclick", onDbl);
		return () => document.removeEventListener("dblclick", onDbl);
	}, [open]);

	// 收藏（P1）：按 assetId 走服务端。uri → assetId 经三元映射反查（id 是真理，uri 只是缓存）
	const assetIdOfUri = (uri: string): string | undefined => useProjectStore.getState().blobByUri(uri)?.id;
	const isFav = (uri: string) => favIds.has(assetIdOfUri(uri) ?? "");
	const toggleFav = async (item: AssetItem) => {
		const id = assetIdOfUri(item.uri);
		if (!id) {
			// 还没上传到服务端的素材没有 assetId，无从收藏（收藏的本质是「让服务端永久保留它」）
			showToast("该素材还没有同步到云端，暂时无法收藏");
			return;
		}
		const ok = await favToggle(id);
		if (!ok) {
			const err = useFavoritesStore.getState().lastError;
			showToast(err || "操作失败");
			useFavoritesStore.getState().clearError();
		}
	};

	// 拖动展开面板（按标题栏）：自由移动，松手停在原处（展开态不再吸附边缘），记忆自由坐标
	const startPanelDrag = (e: React.MouseEvent) => {
		const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
		panelDragRef.current = { offX: e.clientX - rect.left, offY: e.clientY - rect.top };
		setPanelDrag({ x: rect.left, y: rect.top });
		const onMove = (ev: MouseEvent) => {
			const d = panelDragRef.current; if (!d) return;
			setPanelDrag({ x: ev.clientX - d.offX, y: ev.clientY - d.offY });
		};
		const onUp = (ev: MouseEvent) => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			const d = panelDragRef.current;
			panelDragRef.current = null;
			if (d) {
				// 不吸附：留在落点（仅做轻量越界保护，保证标题栏可再次抓取）
				// 自由拖动（不做硬边界）：仅保留 ~40px 可抓取区，防止面板被拖到完全不可见
				const x = Math.min(Math.max(ev.clientX - d.offX, 40 - PANEL_W), window.innerWidth - 40);
				const y = Math.min(Math.max(ev.clientY - d.offY, 4), Math.max(4, window.innerHeight - 40));
				const next = { x, y };
				setPanelPos(next);
				try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
			}
			setPanelDrag(null);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	if (!open && !popout) {
		const style: React.CSSProperties = drag
			? { left: drag.x, top: drag.y }
			: { [pos.side]: 14, top: pos.top };
		return (
			<button
				onMouseDown={(e) => startDockDrag(e, 0, () => setOpen(true))}
				title="资产助手（可拖动到左右边缘）"
				style={{ position: "fixed", zIndex: zBase, width: DOCK_BTN, height: DOCK_BTN, borderRadius: "50%", border: "none", cursor: drag ? "grabbing" : "grab", background: accent, color: "#fff", boxShadow: "0 6px 20px rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", userSelect: "none", ...style }}>
				<Boxes size={22} />
			</button>
		);
	}

	// 展开态自由定位（不吸附边缘）：用记忆的自由坐标；首次展开默认贴近图标当前侧、不溢出。拖动中用实时坐标。
	const panelW = PANEL_W;
	const viewW = typeof window !== "undefined" ? window.innerWidth : 1200;
	const viewH = typeof window !== "undefined" ? window.innerHeight : 800;
	const defaultLeft = pos.side === "left" ? 14 : Math.max(14, viewW - panelW - 14);
	const defaultTop = Math.min(Math.max(pos.top - 40, 12), Math.max(12, viewH - 740));
	const panelStyle: React.CSSProperties = panelDrag
		? { left: panelDrag.x, top: panelDrag.y }
		: { left: panelPos?.x ?? defaultLeft, top: panelPos?.y ?? defaultTop };
	const rootStyle: React.CSSProperties = popout
		? { position: "fixed", inset: 0, width: "100%", height: "100%", display: "flex", flexDirection: "column", background: panel.background, border: "none", borderRadius: 0 }
		: { position: "fixed", zIndex: zBase, width: panelW, height: "min(740px, 86vh)", display: "flex", flexDirection: "column", ...panel, boxShadow: "0 10px 40px rgba(0,0,0,0.55)", ...panelStyle };
	return (
		<div ref={panelRef} style={rootStyle}>
			<div onMouseDown={popout ? undefined : startPanelDrag} title={popout ? undefined : "拖动标题栏可移动"}
				style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", cursor: popout ? "default" : panelDrag ? "grabbing" : "grab", userSelect: "none" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8, color: "#fff", fontSize: 14, fontWeight: 600 }}><Boxes size={17} /> 资产助手</div>
				{!popout && (
					<div style={{ display: "flex", alignItems: "center", gap: 6 }} onMouseDown={(e) => e.stopPropagation()}>
						<button
							title="检查本项目全部资产的云端（OSS）直链是否正常，死链且本机有本地副本则自动修复"
							onClick={() => { void runAssetCheck(allProjectAssetTargets(), "检查所有资产"); }}
							style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", border: "1px solid rgba(52,211,153,0.35)", background: "rgba(52,211,153,0.08)", color: "#34d399" }}>
							<ShieldCheck size={13} /> 检查所有资产
						</button>
						<button title="收起到悬浮图标" onClick={() => setOpen(false)}
							style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", fontSize: 12.5, borderRadius: 6, cursor: "pointer", border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.85)" }}>
							<ChevronsRight size={15} /> 收起
						</button>
					</div>
				)}
			</div>

			<div style={{ display: "flex", gap: 6, padding: "10px 14px 0" }}>
				{MAJORS.map((m) => (
					<button key={m.v} onClick={() => setMajor(m.v)}
						style={{ flex: 1, padding: "7px 0", fontSize: 12.5, borderRadius: 6, cursor: "pointer", border: "1px solid " + (major === m.v ? accent : "rgba(255,255,255,0.1)"), background: major === m.v ? "rgba(139,92,246,0.15)" : "transparent", color: major === m.v ? "#c4b5fd" : "rgba(255,255,255,0.6)" }}>
						{m.label}
					</button>
				))}
			</div>

			{major !== "shared" && (
			<div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "10px 14px" }}>
				{SUBS.map((s) => (
					<button key={s.v} onClick={() => setSub(s.v)}
						style={{ padding: "4px 13px", fontSize: 12, borderRadius: 999, cursor: "pointer", border: "1px solid " + (sub === s.v ? accent : "rgba(255,255,255,0.12)"), background: sub === s.v ? accent : "transparent", color: sub === s.v ? "#fff" : "rgba(255,255,255,0.6)" }}>
						{s.label}
					</button>
				))}
			</div>
			)}

			{/* 收藏配额条（P1）：说清「收藏=云端永久保留」，超额只挡新增收藏、不影响生成与使用 */}
			{major === "favorite" && favQuota && (
				<div style={{ padding: "6px 14px 8px", fontSize: 11.5, color: "rgba(255,255,255,0.55)" }}>
					<div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
						<span>收藏后云端永久保留，可跨设备打开</span>
						<span style={{ fontVariantNumeric: "tabular-nums" }}>
							{fmtMB(favQuota.usedBytes)} / {fmtMB(favQuota.limitBytes)}
							{favQuota.grantBytes > 0 && <span style={{ color: "#6890F8" }}>（含扩容 {fmtMB(favQuota.grantBytes)}）</span>}
						</span>
					</div>
					<div style={{ height: 3, borderRadius: 2, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
						<div style={{
							height: "100%", borderRadius: 2,
							width: `${Math.min(100, favQuota.limitBytes ? (favQuota.usedBytes / favQuota.limitBytes) * 100 : 0).toFixed(1)}%`,
							background: favQuota.usedBytes >= favQuota.limitBytes ? "#f26d8d" : "#6890F8",
						}} />
					</div>
				</div>
			)}
			{favMsg && (
				<div style={{ margin: "0 14px 8px", padding: "6px 10px", borderRadius: 6, fontSize: 11.5, background: "rgba(242,109,141,0.14)", color: "#ffb8c8" }}>
					{favMsg}
				</div>
			)}

			<div style={{ flex: 1, overflowY: "auto", padding: major === "shared" ? "12px 14px 8px" : "4px 14px 8px" }}>
				{major === "shared" ? (
					<SharedPanel />
				) : items.length === 0 ? (
					<div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, textAlign: "center", padding: "50px 10px" }}>
						{major === "favorite" ? "暂无收藏，点资产卡的 ☆ 收藏（收藏后云端永久保留）" : "该分类暂无已出图资产"}
					</div>
				) : (
					<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
						{items.map((it, i) => {
							const forms = it.forms ?? [];
							const hasForms = major === "project" && !!it.id && forms.length > 1; // 有多个造型才可右击选择
							return (
								<div key={i} draggable onDragStart={(e) => onCardDragStart(e, it)}
									onMouseDown={(e) => startAssetDragToCanvas(e, it)}
									onDoubleClick={() => openLightbox({ uri: it.uri, name: it.name, media: "image", voiceUri: it.voiceUri, voiceName: it.voiceName })}
									onContextMenu={(e) => { e.preventDefault(); setFormMenu({ x: e.clientX, y: e.clientY, item: it }); }}
									title={`${it.name}（双击放大 / 拖到素材区=垫图 / 画布=新建图片节点 / 软件外=复制原图 / 右键：检查素材${hasForms ? `·选择造型（${forms.length}）` : ""}）`}
									style={{ position: "relative", aspectRatio: "1/1", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.1)", background: `center/cover no-repeat url(${it.uri})`, cursor: "grab" }}>
									{hasForms && (
										<span title={`${forms.length} 个造型，右键选择`} style={{ position: "absolute", top: 3, left: 3, fontSize: 9.5, color: "#fff", background: "rgba(0,0,0,0.55)", borderRadius: 4, padding: "1px 5px", lineHeight: 1.4 }}>{forms.length}造型</span>
									)}
									<span onClick={(e) => { e.stopPropagation(); toggleFav(it); }} title={isFav(it.uri) ? "取消收藏" : "收藏"}
										style={{ position: "absolute", top: 3, right: 3, width: 22, height: 22, borderRadius: "50%", background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
										<Star size={13} color={isFav(it.uri) ? "#fbbf24" : "#fff"} fill={isFav(it.uri) ? "#fbbf24" : "none"} />
									</span>
									{it.voiceUri && (
										<span onClick={(e) => { e.stopPropagation(); toggleVoice(it.voiceUri!); }}
											onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
											title={`已绑定音色：${it.voiceName || "声音参考"}（点击${playingVoice === it.voiceUri ? "停止" : "播放"}）`}
											style={{ position: "absolute", right: 3, bottom: 20, width: 22, height: 22, borderRadius: "50%", background: playingVoice === it.voiceUri ? "rgba(139,92,246,0.95)" : "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
											<Volume2 size={12} color="#fff" />
										</span>
									)}
									<span style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 10, color: "#fff", background: "rgba(0,0,0,0.55)", padding: "2px 5px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
								</div>
							);
						})}
					</div>
				)}
			</div>

			<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", padding: "8px 14px", borderTop: "1px solid rgba(255,255,255,0.08)", lineHeight: 1.5 }}>
				拖到素材区 = 垫图·拖到画布 = 新建图片节点·拖到软件外 = 复制·右键资产 = 选择造型
			</div>

			{formMenu && (
				<>
					<div onClick={() => setFormMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFormMenu(null); }}
						style={{ position: "fixed", inset: 0, zIndex: zBase + 100 }} />
					<div style={{ position: "fixed", left: Math.min(formMenu.x, window.innerWidth - 232), top: Math.min(formMenu.y, window.innerHeight - 240), zIndex: zBase + 101, width: 220, maxHeight: 320, overflowY: "auto", padding: 10, ...panel, boxShadow: "0 10px 40px rgba(0,0,0,0.6)" }}>
						<div
							onClick={() => {
								const it = formMenu.item;
								const entries = [{ uri: it.uri, name: it.name }, ...((it.forms ?? []).map((f) => ({ uri: f.uri, name: f.label || it.name })))];
								setFormMenu(null);
								void runAssetCheck(uriCheckTargets(entries), `检查素材（${it.name}）`);
							}}
							title="检查该资产的图（主图/造型）云端直链是否正常，死链且本机有本地副本则自动修复"
							style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#34d399", marginBottom: (formMenu.item.forms ?? []).length > 1 ? 8 : 0 }}
							onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
							onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
							<ShieldCheck size={13} />检查素材
						</div>
						<div
							onClick={() => {
								const it = formMenu.item;
								setFormMenu(null);
								const item = sharedItemFromUri(it.uri, it.name);
								openSharedPick(item ? [item] : [], item ? 0 : 1);
							}}
							title="把该资产（当前显示的造型图）登记到共享文件夹（只存 OSS 记录，不复制文件）"
							style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#c4b5fd", marginBottom: (formMenu.item.forms ?? []).length > 1 ? 8 : 0 }}
							onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
							onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
							<Share2 size={13} />添加到共享资产
						</div>
						{(formMenu.item.forms ?? []).length > 1 && (
						<div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", marginBottom: 8 }}>选择造型·{formMenu.item.baseName || formMenu.item.name}</div>
						)}
						{(formMenu.item.forms ?? []).length > 1 && (
						<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
							{(formMenu.item.forms ?? []).map((f, i) => {
								const active = (f.variantId ?? null) === (formMenu.item.variantId ?? null);
								return (
									<div key={i} title={f.label + (active ? "（当前）" : "")}
										onClick={() => { if (formMenu.item.id) useAssetFormStore.getState().setSelForm(formMenu.item.id, f.variantId ?? null); setFormMenu(null); }}
										style={{ position: "relative", aspectRatio: "1/1", borderRadius: 6, overflow: "hidden", cursor: "pointer", border: "2px solid " + (active ? accent : "rgba(255,255,255,0.12)"), background: `center/cover no-repeat url(${f.uri})` }}>
										{active && <span style={{ position: "absolute", inset: 0, background: "rgba(139,92,246,0.25)" }} />}
										<span style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 9, color: "#fff", background: "rgba(0,0,0,0.6)", padding: "1px 3px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "center" }}>{f.label}</span>
									</div>
								);
							})}
						</div>
					)}
					</div>
				</>
			)}
		</div>
	);
}

/* ════════ 共享资产（第120轮）：三级 = 共享库 / 文件夹 / 素材，惰性加载 ════════
   点「获取」才拉取：库主页只拉文件夹+数量，进文件夹再拉素材并下载到本地（进度条）；
   不获取时只显示本地已缓存的素材。素材=OSS 记录（分享不复制字节，使用方解析直链下载）。 */

/** 把共享素材登记进项目 blob 三元映射（台账 id 优先），使拖拽/垫图完全复用既有流程（blobByUri → 公网 url） */
function ensureSharedBlob(rec: CachedSharedAsset): void {
	if (!rec.url || !rec.localUri) return;
	useProjectStore.getState().registerAssetBlob({
		id: rec.assetId || rec.id, url: rec.url, srcUri: rec.localUri,
		localPath: rec.localPath, localUri: rec.localUri, mime: rec.mime,
	});
}

const shBtn: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", fontSize: 12, borderRadius: 6, cursor: "pointer", border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.85)" };
const shRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.03)", cursor: "pointer" };

type SharedView = { level: "libs" } | { level: "folders"; libId: string } | { level: "assets"; libId: string; folderId: string };

function SharedPanel() {
	const libs = useSharedLibStore((s) => s.libs);
	const foldersByLib = useSharedLibStore((s) => s.foldersByLib);
	const assetsByFolder = useSharedLibStore((s) => s.assetsByFolder);
	const fetching = useSharedLibStore((s) => s.fetching);
	const initialized = useSharedLibStore((s) => s.initialized);
	const [view, setViewRaw] = useState<SharedView>({ level: "libs" });
	// 文件夹内素材分类（第121轮）：按台账 id 前缀分 角色/场景/生物/群像/道具/其他；切换文件夹时回到「全部」
	const [shCat, setShCat] = useState<"all" | SubCat>("all");
	// 导航即记忆：写入 lastView（随缓存持久化），下次打开共享页恢复到上次所在的库/文件夹
	const setView = (v: SharedView) => {
		setViewRaw(v);
		setShCat("all");
		useSharedLibStore.getState().setLastView(
			v.level === "libs" ? null : { libId: v.libId, folderId: v.level === "assets" ? v.folderId : undefined },
		);
	};
	// 挂载恢复上次位置（缓存里库/文件夹仍存在才恢复；只恢复一次）
	const restoredRef = useRef(false);
	useEffect(() => {
		if (!initialized || restoredRef.current) return;
		restoredRef.current = true;
		const s = useSharedLibStore.getState();
		const lv = s.lastView;
		if (!lv || !s.libs.some((l) => l.id === lv.libId)) return;
		if (lv.folderId && (s.foldersByLib[lv.libId] ?? []).some((f) => f.id === lv.folderId)) {
			setViewRaw({ level: "assets", libId: lv.libId, folderId: lv.folderId });
		} else {
			setViewRaw({ level: "folders", libId: lv.libId });
		}
	}, [initialized]);
	// 文件夹层自动获取（第121轮）：进入库主页即自动拉文件夹列表（新文件夹免手动点「获取」）；
	// 素材层保持手动「获取」（素材要下载字节到本地，成本高）。fetching 守卫防重入，失败静默（按钮仍可手动重试）。
	useEffect(() => {
		if (view.level !== "folders") return;
		const libId = view.libId;
		if (useSharedLibStore.getState().fetching[libId]) return;
		void useSharedLibStore.getState().fetchFolders(libId).catch((e) => console.warn("[shared] 自动获取文件夹失败:", e));
	}, [view]);

	// 右键共享卡 → 绑定/添加到当前项目资产（复用画布「绑定到资产」弹窗与实现）
	const [bindMenu, setBindMenu] = useState<{ x: number; y: number; rec: CachedSharedAsset; media: "image" | "audio" } | null>(null);
	const [bindTarget, setBindTarget] = useState<{ rec: CachedSharedAsset; mode: "image" | "voice" } | null>(null);
	const [q, setQ] = useState("");
	const [results, setResults] = useState<Array<SharedLibraryInfo & { joined?: boolean }> | null>(null);
	const [joining, setJoining] = useState<SharedLibraryInfo | null>(null);
	const [pw, setPw] = useState("");
	const [err, setErr] = useState("");
	const [busy, setBusy] = useState(false);
	const [sharePick, setSharePick] = useState(false);
	const [picked, setPicked] = useState<Record<string, boolean>>({});
	const fileRef = useRef<HTMLInputElement>(null);

	useEffect(() => { void useSharedLibStore.getState().init(); }, []);

	const cats = useProjectStore((s) => ({ characters: s.characters, scenes: s.scenes, organisms: s.organisms, crowds: s.crowds, items: s.items }));
	// 「共享项目资产」候选：全部五类已出图资产（基础形象+造型）——分享=登记其 OSS 记录，不重复上传
	const shareCands = useMemo(() => {
		const out: Array<{ key: string; name: string; uri: string }> = [];
		for (const arr of Object.values(cats)) {
			for (const a of (arr as Array<{ id: string; name: string; image?: string; variants?: Array<{ id: string; label?: string; image?: string }> }>) ?? []) {
				if (a.image) out.push({ key: `${a.id}:base`, name: a.name, uri: a.image });
				for (const v of a.variants ?? []) if (v.image) out.push({ key: `${a.id}:${v.id}`, name: `${a.name}·${v.label || "造型"}`, uri: v.image });
			}
		}
		return out;
	}, [cats]);

	const doSearch = async () => {
		if (!q.trim()) return;
		setBusy(true); setErr("");
		try { setResults(await managedClient.sharedSearch(q.trim())); }
		catch (e) { setErr(e instanceof Error ? e.message : "搜索失败"); }
		finally { setBusy(false); }
	};
	const doJoin = async () => {
		if (!joining) return;
		setBusy(true); setErr("");
		const r = await managedClient.sharedJoin(joining.id, pw);
		setBusy(false);
		if (!r.ok || !r.library) { setErr(r.error || "加入失败"); return; }
		useSharedLibStore.getState().addLib(r.library);
		setJoining(null); setPw(""); setResults(null); setQ("");
	};
	const doLeave = async (lib: SharedLibraryInfo) => {
		if (!(await confirmDialog(`退出共享库「${lib.name}」？本地已下载的缓存保留，重新加入需再次输入密码。`))) return;
		void managedClient.sharedLeave(lib.id).catch(() => {});
		useSharedLibStore.getState().removeLib(lib.id);
		setView({ level: "libs" });
	};
	const doCreateFolder = async (libId: string) => {
		const name = prompt("新文件夹名称：")?.trim();
		if (!name) return;
		const r = await managedClient.sharedCreateFolder(libId, name);
		if (!r.ok || !r.folder) { alert(r.error || "创建失败"); return; }
		useSharedLibStore.getState().addFolder(libId, r.folder);
	};
	// 分享项目资产：登记所选资产的 OSS 记录（blob.id=台账 id 是真理；无公网记录的跳过）
	const doShareProject = async (folderId: string) => {
		const items: Array<{ assetId?: string; url?: string; name: string }> = [];
		let noUrl = 0;
		for (const c of shareCands) {
			if (!picked[c.key]) continue;
			const blob = useProjectStore.getState().blobByUri(c.uri);
			if (blob?.id || blob?.url) items.push({ assetId: blob.id, url: blob.url, name: c.name });
			else noUrl++;
		}
		if (!items.length) { alert(noUrl ? "所选资产都没有 OSS 记录（本地图需先在生成/上传流程中入库）。" : "请先勾选要分享的资产。"); return; }
		setBusy(true);
		const r = await managedClient.sharedAddAssets(folderId, items);
		setBusy(false);
		setSharePick(false); setPicked({});
		if (!r.ok) { alert(r.error || "分享失败"); return; }
		alert(`已分享 ${r.added ?? 0} 条${r.skipped ? `（跳过重复/无直链 ${r.skipped} 条）` : ""}${noUrl ? `；${noUrl} 条无 OSS 记录未分享` : ""}`);
		void useSharedLibStore.getState().fetchFolderAssets(folderId);
	};
	// 上传本机文件：磁盘文件先经现有上传通道入 OSS（一次），再登记记录
	const doUploadFiles = async (folderId: string, files: FileList | null) => {
		if (!files?.length) return;
		setBusy(true);
		const items: Array<{ assetId?: string; url?: string; name: string; mime?: string }> = [];
		for (const f of Array.from(files)) {
			try {
				const up = await managedClient.uploadAsset(f, f.name, "TP");
				items.push({ assetId: up.id, url: up.url, name: f.name.replace(/\.[^.]+$/, ""), mime: f.type || undefined });
			} catch (e) { console.warn("[shared] upload failed:", f.name, e); }
		}
		if (items.length) {
			const r = await managedClient.sharedAddAssets(folderId, items);
			if (!r.ok) alert(r.error || "登记失败");
			else void useSharedLibStore.getState().fetchFolderAssets(folderId);
		} else alert("上传失败：没有文件成功入库");
		setBusy(false);
	};

	// ── 一级：已加入的库 + 查找加入 ──
	if (view.level === "libs") {
		return (
			<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				<div style={{ display: "flex", gap: 6 }}>
					<input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void doSearch(); }}
						placeholder="搜索共享库名称（向管理员/服务商索取）"
						style={{ flex: 1, minWidth: 0, padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)", color: "#fff" }} />
					<button style={shBtn} disabled={busy} onClick={() => void doSearch()}>搜索</button>
					<button style={shBtn} title="刷新已加入的库列表" onClick={() => void useSharedLibStore.getState().fetchLibs().catch((e) => setErr(e?.message || "获取失败"))}><RefreshCw size={12} /> 获取</button>
				</div>
				{err && <div style={{ fontSize: 11.5, color: "#f87171" }}>{err}</div>}
				{results && (
					<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						<div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)" }}>搜索结果（{results.length}）：</div>
						{results.length === 0 && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)" }}>没有找到该名称的共享库（全局搜索：本软件内任何共享库都可按名搜到，凭加入密码加入）。</div>}
						{results.map((l) => (
							<div key={l.id} style={{ ...shRow, cursor: "default" }}>
								<Folder size={14} color="#c4b5fd" />
								<span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
								<span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{l.folderCount} 文件夹 · {l.assetCount} 素材</span>
								{l.joined ? <span style={{ fontSize: 11.5, color: "#34d399" }}>已加入</span>
									: <button style={{ ...shBtn, color: "#c4b5fd", borderColor: "rgba(139,92,246,0.5)" }} onClick={() => { setJoining(l); setPw(""); setErr(""); }}><LogIn size={12} /> 加入</button>}
							</div>
						))}
					</div>
				)}
				{joining && (
					<div style={{ padding: 10, borderRadius: 8, border: "1px solid rgba(139,92,246,0.45)", background: "rgba(139,92,246,0.08)", display: "flex", flexDirection: "column", gap: 8 }}>
						<div style={{ fontSize: 12.5, color: "#fff" }}>加入「{joining.name}」— 输入加入密码：</div>
						<div style={{ display: "flex", gap: 6 }}>
							<input value={pw} onChange={(e) => setPw(e.target.value)} type="password" autoFocus onKeyDown={(e) => { if (e.key === "Enter") void doJoin(); }}
								style={{ flex: 1, padding: "6px 10px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.05)", color: "#fff" }} />
							<button style={{ ...shBtn, background: accent, borderColor: accent, color: "#fff" }} disabled={busy} onClick={() => void doJoin()}>加入</button>
							<button style={shBtn} onClick={() => { setJoining(null); setErr(""); }}>取消</button>
						</div>
					</div>
				)}
				<div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.5)", marginTop: 2 }}>已加入的共享库（{libs.length}）：</div>
				{libs.length === 0 && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textAlign: "center", padding: "26px 10px" }}>还没有加入共享库——向管理员/服务商索取「库名+加入密码」，在上方搜索加入。</div>}
				{libs.map((l) => (
					<div key={l.id} style={shRow} onClick={() => setView({ level: "folders", libId: l.id })} title="点击进入">
						<Folder size={15} color="#c4b5fd" />
						<span style={{ flex: 1, minWidth: 0, fontSize: 13, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
						<span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{l.folderCount} 文件夹 · {l.assetCount} 素材</span>
						<button style={{ ...shBtn, padding: "3px 8px", fontSize: 11 }} onClick={(e) => { e.stopPropagation(); doLeave(l); }}>退出</button>
					</div>
				))}
			</div>
		);
	}

	// ── 二级：库主页（文件夹 + 数量；「获取」只拉这一层） ──
	if (view.level === "folders") {
		const lib = libs.find((l) => l.id === view.libId);
		const folders = foldersByLib[view.libId] ?? [];
		const loading = !!fetching[view.libId];
		return (
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
					<button style={shBtn} onClick={() => setView({ level: "libs" })}><ChevronLeft size={13} /> 返回</button>
					<span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lib?.name || "共享库"}</span>
					<button style={shBtn} title="新建文件夹" onClick={() => void doCreateFolder(view.libId)}><FolderPlus size={13} /> 文件夹</button>
					<button style={{ ...shBtn, color: "#c4b5fd" }} disabled={loading} title="进入时已自动获取文件夹列表；点击手动刷新（不加载素材本体）"
						onClick={() => void useSharedLibStore.getState().fetchFolders(view.libId).catch((e) => alert(e?.message || "获取失败"))}>
						<RefreshCw size={12} /> {loading ? "获取中…" : "刷新"}
					</button>
				</div>
				{folders.length === 0 && <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textAlign: "center", padding: "30px 10px" }}>{loading ? "获取中…" : "本地暂无文件夹缓存——点右上「获取」加载（或「＋文件夹」新建）。"}</div>}
				{folders.map((f) => (
					<div key={f.id} style={shRow} onClick={() => setView({ level: "assets", libId: view.libId, folderId: f.id })} title="点击进入文件夹">
						<Folder size={15} color="#fbbf24" />
						<span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
						<span style={{ fontSize: 11, color: "rgba(255,255,255,0.45)" }}>{f.count} 素材</span>
					</div>
				))}
			</div>
		);
	}

	// ── 三级：文件夹内素材（「获取」拉记录+下载到本地，进度条；不获取只显示本地缓存） ──
	const folder = (foldersByLib[view.libId] ?? []).find((f) => f.id === view.folderId);
	const all = assetsByFolder[view.folderId] ?? [];
	const localAssets = all.filter((r) => r.localUri);
	const prog = fetching[view.folderId];
	// 按台账 id 前缀分类过滤（角色/场景/生物/群像/道具/其他）
	const shownAssets = shCat === "all" ? localAssets : localAssets.filter((r) => sharedCatOf(r.assetId) === shCat);
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
				<button style={shBtn} onClick={() => setView({ level: "folders", libId: view.libId })}><ChevronLeft size={13} /> 返回</button>
				<span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{folder?.name || "文件夹"}</span>
				<button style={shBtn} title="把本项目资产/本机文件分享进此文件夹（只登记 OSS 记录）" onClick={() => { setSharePick((v) => !v); setPicked({}); }}><Share2 size={12} /> 分享</button>
				<button style={{ ...shBtn, color: "#c4b5fd" }} disabled={!!prog} title="拉取本文件夹素材并下载到本地（二次点击=更新）"
					onClick={() => void useSharedLibStore.getState().fetchFolderAssets(view.folderId).catch((e) => alert(e?.message || "获取失败"))}>
					<RefreshCw size={12} /> {prog ? "获取中…" : localAssets.length ? "更新" : "获取"}
				</button>
			</div>
			{localAssets.length > 0 && (
				<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
					{([{ v: "all", label: "全部" } as { v: "all" | SubCat; label: string }, ...SUBS]).map((s) => {
						const n = s.v === "all" ? localAssets.length : localAssets.filter((r) => sharedCatOf(r.assetId) === s.v).length;
						const active = shCat === s.v;
						return (
							<button key={s.v} onClick={() => setShCat(s.v)} title={`${s.label}（${n} 条）`}
								style={{ padding: "3px 11px", fontSize: 11.5, borderRadius: 999, cursor: "pointer", border: "1px solid " + (active ? accent : "rgba(255,255,255,0.12)"), background: active ? accent : "transparent", color: active ? "#fff" : n ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.3)" }}>
								{s.label}{n ? ` ${n}` : ""}
							</button>
						);
					})}
				</div>
			)}
			{prog && (
				<div>
					<div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "rgba(255,255,255,0.55)", marginBottom: 3 }}>
						<span>正在下载素材到本地…</span><span>{prog.done}/{prog.total}</span>
					</div>
					<div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
						<div style={{ height: "100%", width: `${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%`, background: "linear-gradient(90deg,#8b5cf6,#a78bfa)", transition: "width .2s" }} />
					</div>
				</div>
			)}
			{sharePick && (
				<div style={{ padding: 10, borderRadius: 8, border: "1px solid rgba(139,92,246,0.45)", background: "rgba(139,92,246,0.07)", display: "flex", flexDirection: "column", gap: 8 }}>
					<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
						<span style={{ fontSize: 12, color: "#fff", flex: 1 }}>勾选项目资产分享（只登记 OSS 记录，不重复上传）：</span>
						<label style={{ ...shBtn, margin: 0 }} title="磁盘文件先入库 OSS 一次，再登记记录">
							<Upload size={12} /> 本机文件
							<input ref={fileRef} type="file" multiple accept="image/*,video/*,audio/*" style={{ display: "none" }}
								onChange={(e) => { void doUploadFiles(view.folderId, e.target.files); e.target.value = ""; }} />
						</label>
					</div>
					{shareCands.length === 0 ? <div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.45)" }}>当前项目还没有已出图的资产。</div> : (
						<div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, maxHeight: 200, overflowY: "auto" }}>
							{shareCands.map((c) => (
								<div key={c.key} onClick={() => setPicked((p) => ({ ...p, [c.key]: !p[c.key] }))} title={c.name}
									style={{ position: "relative", aspectRatio: "1/1", borderRadius: 6, overflow: "hidden", cursor: "pointer", border: "2px solid " + (picked[c.key] ? accent : "rgba(255,255,255,0.12)"), background: `center/cover no-repeat url(${c.uri})` }}>
									{picked[c.key] && <span style={{ position: "absolute", inset: 0, background: "rgba(139,92,246,0.3)" }} />}
									<span style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 9, color: "#fff", background: "rgba(0,0,0,0.6)", padding: "1px 3px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
								</div>
							))}
						</div>
					)}
					<div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
						<button style={shBtn} onClick={() => { setSharePick(false); setPicked({}); }}>取消</button>
						<button style={{ ...shBtn, background: accent, borderColor: accent, color: "#fff" }} disabled={busy}
							onClick={() => void doShareProject(view.folderId)}>分享所选（{Object.values(picked).filter(Boolean).length}）</button>
					</div>
				</div>
			)}
			{localAssets.length === 0 && !prog && (
				<div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textAlign: "center", padding: "30px 10px" }}>
					本地暂无已加载素材{folder?.count ? `（云端共 ${folder.count} 条）` : ""}——点右上「获取」下载到本地。
				</div>
			)}
			{localAssets.length > 0 && shownAssets.length === 0 && (
				<div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", textAlign: "center", padding: "24px 10px" }}>该分类暂无素材。</div>
			)}
			{shownAssets.length > 0 && (
				<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
					{shownAssets.map((rec) => {
						const media = rec.mime?.startsWith("video/") ? "video" : rec.mime?.startsWith("audio/") ? "audio" : "image";
						const item: AssetItem = { uri: rec.localUri!, name: rec.name, cat: sharedCatOf(rec.assetId) };
						return (
							<div key={rec.id} draggable
								onDragStart={(e) => { ensureSharedBlob(rec); onCardDragStart(e, item); }}
								onMouseDown={media === "image" ? (e) => { ensureSharedBlob(rec); startAssetDragToCanvas(e, item); } : undefined}
								onDoubleClick={() => openLightbox({ uri: rec.localUri || rec.url, name: rec.name, media })}
								onContextMenu={media !== "video" ? (e) => { e.preventDefault(); setBindMenu({ x: e.clientX, y: e.clientY, rec, media: media as "image" | "audio" }); } : undefined}
								title={`${rec.name}（双击放大 / 拖到素材区=垫图 / 画布=新建图片节点${media !== "video" ? " / 右键：添加到项目资产" : ""}）`}
								style={{ position: "relative", aspectRatio: "1/1", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.1)", background: media === "image" ? `center/cover no-repeat url(${rec.localUri})` : "rgba(255,255,255,0.05)", cursor: "grab", display: "flex", alignItems: "center", justifyContent: "center" }}>
								{media === "video" && <video src={rec.localUri} style={{ width: "100%", height: "100%", objectFit: "cover" }} muted preload="metadata" />}
								{media === "audio" && <span style={{ fontSize: 22 }}>🎵</span>}
								<span style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 10, color: "#fff", background: "rgba(0,0,0,0.55)", padding: "2px 5px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{rec.name}</span>
							</div>
						);
					})}
				</div>
			)}
			{bindMenu && (
				<>
					<div onClick={() => setBindMenu(null)} onContextMenu={(e) => { e.preventDefault(); setBindMenu(null); }}
						style={{ position: "fixed", inset: 0, zIndex: 100200 }} />
					<div style={{ position: "fixed", left: Math.min(bindMenu.x, window.innerWidth - 220), top: Math.min(bindMenu.y, window.innerHeight - 90), zIndex: 100201, width: 208, padding: 6, ...panel, boxShadow: "0 10px 40px rgba(0,0,0,0.6)" }}>
						<div
							onClick={() => {
								const { rec, media } = bindMenu;
								setBindMenu(null);
								ensureSharedBlob(rec); // 先登记三元映射：绑入项目后请求时可解析公网 url
								setBindTarget({ rec, mode: media === "audio" ? "voice" : "image" });
							}}
							title={bindMenu.media === "audio" ? "把该共享音频绑为某个项目资产的音色（与资产模式绑音色同格式）" : "把该共享图设为某个项目资产的主图（进历史），或新建资产绑定"}
							style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 9px", borderRadius: 6, cursor: "pointer", fontSize: 12, color: "#c4b5fd" }}
							onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.06)")}
							onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
							<Link2 size={13} />{bindMenu.media === "audio" ? "绑定为项目资产音色…" : "添加到项目资产…"}
						</div>
					</div>
				</>
			)}
			{bindTarget && (
				<AssetBindModal
					source={{ uri: bindTarget.rec.localUri || bindTarget.rec.url, name: bindTarget.rec.name, serverAssetId: bindTarget.rec.assetId || bindTarget.rec.id }}
					mode={bindTarget.mode}
					onCancel={() => setBindTarget(null)}
				/>
			)}
		</div>
	);
}
