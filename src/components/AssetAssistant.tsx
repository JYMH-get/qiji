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
import { ensureDragThumb, ensureLocalOriginal } from "@/services/assetPersist";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { Boxes, ChevronsRight, Star } from "lucide-react";

function isTauriEnv(): boolean {
	return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

type Major = "project" | "favorite" | "shared";
interface AssetItem { uri: string; name: string; cat: AssetCat; id?: string; variantId?: string | null; images?: string[] }

const MAJORS: Array<{ v: Major; label: string }> = [
	{ v: "project", label: "项目资产" },
	{ v: "favorite", label: "收藏资产" },
	{ v: "shared", label: "共享资产" },
];
const SUBS: Array<{ v: AssetCat; label: string }> = [
	{ v: "characters", label: "角色" },
	{ v: "scenes", label: "场景" },
	{ v: "organisms", label: "生物" },
	{ v: "crowds", label: "群像" },
	{ v: "items", label: "道具" },
];

const FAV_KEY = "Qiji:favoriteAssets";
const POS_KEY = "Qiji:assistantPos";
const BTN = 48;
const PANEL_W = 440;

function loadFavorites(): AssetItem[] {
	try { const r = localStorage.getItem(FAV_KEY); if (r) return JSON.parse(r); } catch { /* ignore */ }
	return [];
}
function saveFavorites(list: AssetItem[]) {
	try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
function loadPos(): { side: "left" | "right"; top: number } {
	try { const r = localStorage.getItem(POS_KEY); if (r) return JSON.parse(r); } catch { /* ignore */ }
	return { side: "right", top: Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.45) };
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
			await startDrag({ item: [fullPath], icon, mode: "copy" }).catch(() => {});
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

const panel: React.CSSProperties = { background: "#12151c", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10 };
const accent = "#8b5cf6";

export default function AssetAssistant() {
	const [open, setOpen] = useState(false);
	const [major, setMajor] = useState<Major>("project");
	const [sub, setSub] = useState<AssetCat>("characters");
	const [favorites, setFavorites] = useState<AssetItem[]>(loadFavorites);

	// 悬浮图标位置（吸附左/右边缘 + 垂直位置）
	const [pos, setPos] = useState(loadPos);
	const [drag, setDrag] = useState<{ x: number; y: number; moved: boolean } | null>(null);
	const dragRef = useRef<{ offX: number; offY: number; startX: number; startY: number; moved: boolean } | null>(null);

	// 展开面板拖动（拖标题栏，松手吸附最近左/右边缘）
	const [panelDrag, setPanelDrag] = useState<{ x: number; y: number } | null>(null);
	const panelDragRef = useRef<{ offX: number; offY: number } | null>(null);

	const cats = useProjectStore((s) => ({ characters: s.characters, scenes: s.scenes, organisms: s.organisms, crowds: s.crowds, items: s.items }));
	const setAssetMainImage = useProjectStore((s) => s.setAssetMainImage);

	// 右键历史菜单（同一资产多次生成时切换主图）
	const [histMenu, setHistMenu] = useState<{ x: number; y: number; item: AssetItem } | null>(null);

	const projectItems = useMemo(() => {
		const out: AssetItem[] = [];
		for (const a of (cats[sub] as any[]) ?? []) {
			if (a.image) out.push({ uri: a.image, name: a.name, cat: sub, id: a.id, variantId: null, images: a.images });
			for (const v of a.variants ?? []) if (v.image) out.push({ uri: v.image, name: `${a.name}·${v.label || "造型"}`, cat: sub, id: a.id, variantId: v.id, images: v.images });
		}
		return out;
	}, [cats, sub]);

	const favItems = useMemo(() => favorites.filter((f) => f.cat === sub), [favorites, sub]);
	const items = major === "project" ? projectItems : major === "favorite" ? favItems : [];

	// 预落盘：为当前展示、尚无本地原件的项目资产后台生成原件，使拖出软件外即时可用（Tauri）
	useEffect(() => {
		if (!isTauriEnv() || !open || major !== "project") return;
		let cancelled = false;
		(async () => {
			for (const it of projectItems) {
				if (cancelled) break;
				if (useProjectStore.getState().blobByUri(it.uri)?.localPath) continue;
				await ensureLocalOriginal(it.uri, { name: it.name }).catch(() => {});
			}
		})();
		return () => { cancelled = true; };
	}, [projectItems, open, major]);

	const isFav = (uri: string) => favorites.some((f) => f.uri === uri);
	const toggleFav = (item: AssetItem) => {
		setFavorites((prev) => {
			const next = prev.some((f) => f.uri === item.uri) ? prev.filter((f) => f.uri !== item.uri) : [...prev, item];
			saveFavorites(next);
			return next;
		});
	};

	// 悬浮图标拖动：按下时挂全局监听，松手吸附最近边缘；几乎没移动则视为点击展开
	const startDrag = (e: React.MouseEvent) => {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		dragRef.current = { offX: e.clientX - rect.left, offY: e.clientY - rect.top, startX: e.clientX, startY: e.clientY, moved: false };
		setDrag({ x: rect.left, y: rect.top, moved: false });
		const onMove = (ev: MouseEvent) => {
			const d = dragRef.current; if (!d) return;
			if (!d.moved && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) > 4) d.moved = true;
			setDrag({ x: ev.clientX - d.offX, y: ev.clientY - d.offY, moved: d.moved });
		};
		const onUp = (ev: MouseEvent) => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			const d = dragRef.current;
			dragRef.current = null;
			if (d && d.moved) {
				const side: "left" | "right" = ev.clientX < window.innerWidth / 2 ? "left" : "right";
				const top = Math.min(Math.max(ev.clientY - BTN / 2, 8), window.innerHeight - BTN - 8);
				const next = { side, top };
				setPos(next);
				try { localStorage.setItem(POS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
			} else {
				setOpen(true); // 视为点击
			}
			setDrag(null);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	// 拖动展开面板（按标题栏）：自由移动，松手吸附最近左/右边缘并记忆垂直位置
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
				const left = ev.clientX - d.offX;
				const side: "left" | "right" = left + PANEL_W / 2 < window.innerWidth / 2 ? "left" : "right";
				const top = Math.min(Math.max(ev.clientY - d.offY + 40, 8), Math.max(8, window.innerHeight - 120));
				const next = { side, top };
				setPos(next);
				try { localStorage.setItem(POS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
			}
			setPanelDrag(null);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	if (!open) {
		const style: React.CSSProperties = drag
			? { left: drag.x, top: drag.y }
			: { [pos.side]: 14, top: pos.top };
		return (
			<button
				onMouseDown={startDrag}
				title="资产助手（可拖动到左右边缘）"
				style={{ position: "fixed", zIndex: 9000, width: BTN, height: BTN, borderRadius: "50%", border: "none", cursor: drag ? "grabbing" : "grab", background: accent, color: "#fff", boxShadow: "0 6px 20px rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", userSelect: "none", ...style }}>
				<Boxes size={22} />
			</button>
		);
	}

	// 面板锚定到同侧边缘，垂直贴近图标位置且不溢出；拖动中则用自由坐标
	const panelW = PANEL_W;
	const panelTop = Math.min(Math.max(pos.top - 40, 12), Math.max(12, (typeof window !== "undefined" ? window.innerHeight : 800) - 740));
	const panelPos: React.CSSProperties = panelDrag
		? { left: panelDrag.x, top: panelDrag.y }
		: { [pos.side]: 14, top: panelTop };
	return (
		<div style={{ position: "fixed", zIndex: 9000, width: panelW, height: "min(740px, 86vh)", display: "flex", flexDirection: "column", ...panel, boxShadow: "0 10px 40px rgba(0,0,0,0.55)", ...panelPos }}>
			<div onMouseDown={startPanelDrag} title="拖动标题栏可移动，松手吸附左/右边缘"
				style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid rgba(255,255,255,0.08)", cursor: panelDrag ? "grabbing" : "grab", userSelect: "none" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8, color: "#fff", fontSize: 14, fontWeight: 600 }}><Boxes size={17} /> 资产助手</div>
				<button title="收起到悬浮图标" onMouseDown={(e) => e.stopPropagation()} onClick={() => setOpen(false)}
					style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 10px", fontSize: 12.5, borderRadius: 6, cursor: "pointer", border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.85)" }}>
					<ChevronsRight size={15} /> 收起
				</button>
			</div>

			<div style={{ display: "flex", gap: 6, padding: "10px 14px 0" }}>
				{MAJORS.map((m) => (
					<button key={m.v} onClick={() => setMajor(m.v)}
						style={{ flex: 1, padding: "7px 0", fontSize: 12.5, borderRadius: 6, cursor: "pointer", border: "1px solid " + (major === m.v ? accent : "rgba(255,255,255,0.1)"), background: major === m.v ? "rgba(139,92,246,0.15)" : "transparent", color: major === m.v ? "#c4b5fd" : "rgba(255,255,255,0.6)" }}>
						{m.label}
					</button>
				))}
			</div>

			<div style={{ display: "flex", gap: 6, padding: "10px 14px", flexWrap: "wrap" }}>
				{SUBS.map((s) => (
					<button key={s.v} onClick={() => setSub(s.v)}
						style={{ padding: "4px 14px", fontSize: 12, borderRadius: 999, cursor: "pointer", border: "1px solid " + (sub === s.v ? accent : "rgba(255,255,255,0.12)"), background: sub === s.v ? accent : "transparent", color: sub === s.v ? "#fff" : "rgba(255,255,255,0.6)" }}>
						{s.label}
					</button>
				))}
			</div>

			<div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 8px" }}>
				{major === "shared" ? (
					<div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, textAlign: "center", padding: "50px 10px" }}>暂无共享资产（待管理端开放）</div>
				) : items.length === 0 ? (
					<div style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, textAlign: "center", padding: "50px 10px" }}>
						{major === "favorite" ? "暂无收藏，点资产卡的 ☆ 收藏" : "该分类暂无已出图资产"}
					</div>
				) : (
					<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
						{items.map((it, i) => {
							const hist = it.images ?? [];
							const hasHist = major === "project" && !!it.id && hist.length > 1;
							return (
							<div key={i} draggable onDragStart={(e) => onCardDragStart(e, it)}
								onContextMenu={hasHist ? (e) => { e.preventDefault(); setHistMenu({ x: e.clientX, y: e.clientY, item: it }); } : undefined}
								title={`${it.name}（拖到素材区=垫图 / 画布=新建节点 / 软件外=复制原图${hasHist ? ` · 右键切换历史（${hist.length}）` : ""}）`}
								style={{ position: "relative", aspectRatio: "1/1", borderRadius: 8, overflow: "hidden", border: "1px solid rgba(255,255,255,0.1)", background: `center/cover no-repeat url(${it.uri})`, cursor: "grab" }}>
								{hasHist && (
									<span title={`${hist.length} 张历史，右键切换`} style={{ position: "absolute", top: 3, left: 3, fontSize: 9.5, color: "#fff", background: "rgba(0,0,0,0.55)", borderRadius: 4, padding: "1px 5px", lineHeight: 1.4 }}>×{hist.length}</span>
								)}
								<span onClick={(e) => { e.stopPropagation(); toggleFav(it); }} title={isFav(it.uri) ? "取消收藏" : "收藏"}
									style={{ position: "absolute", top: 3, right: 3, width: 22, height: 22, borderRadius: "50%", background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
									<Star size={13} color={isFav(it.uri) ? "#fbbf24" : "#fff"} fill={isFav(it.uri) ? "#fbbf24" : "none"} />
								</span>
								<span style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 10, color: "#fff", background: "rgba(0,0,0,0.55)", padding: "2px 5px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.name}</span>
							</div>
							);
						})}
					</div>
				)}
			</div>

			<div style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", padding: "8px 14px", borderTop: "1px solid rgba(255,255,255,0.08)", lineHeight: 1.5 }}>
				拖到素材区 = 垫图 · 拖到画布 = 新建节点 · 拖到软件外 = 复制 · 右键资产 = 切换历史
			</div>

			{histMenu && (
				<>
					<div onClick={() => setHistMenu(null)} onContextMenu={(e) => { e.preventDefault(); setHistMenu(null); }}
						style={{ position: "fixed", inset: 0, zIndex: 9100 }} />
					<div style={{ position: "fixed", left: Math.min(histMenu.x, window.innerWidth - 232), top: Math.min(histMenu.y, window.innerHeight - 240), zIndex: 9101, width: 220, maxHeight: 300, overflowY: "auto", padding: 10, ...panel, boxShadow: "0 10px 40px rgba(0,0,0,0.6)" }}>
						<div style={{ fontSize: 11.5, color: "rgba(255,255,255,0.55)", marginBottom: 8 }}>切换主图 · {histMenu.item.name}</div>
						<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
							{(histMenu.item.images ?? []).map((u, i) => {
								const active = u === histMenu.item.uri;
								return (
									<div key={i} title={active ? "当前主图" : "设为主图"}
										onClick={() => { setAssetMainImage(histMenu.item.cat, histMenu.item.id!, histMenu.item.variantId ?? null, u); setHistMenu(null); }}
										style={{ position: "relative", aspectRatio: "1/1", borderRadius: 6, overflow: "hidden", cursor: "pointer", border: "2px solid " + (active ? accent : "rgba(255,255,255,0.12)"), background: `center/cover no-repeat url(${u})` }}>
										{active && <span style={{ position: "absolute", inset: 0, background: "rgba(139,92,246,0.25)" }} />}
									</div>
								);
							})}
						</div>
					</div>
				</>
			)}
		</div>
	);
}
