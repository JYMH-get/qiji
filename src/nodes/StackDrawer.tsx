/**
 * StackDrawer —— 抽屉式堆叠展开视图（参考手机桌面图标抽屉交互；展开为**屏幕空间大面板+平铺网格**，无动画）。
 *
 *  - 堆叠 = 图片/视频节点的 resultHistory ∪ 主图；节点收起时外观=浅色微旋转纸边（.Qiji-node--stacked）+ 层数角标。
 *  - 入口：节点右键「打开堆叠」/ 快捷键 C / 层数角标点击；同时只开一个抽屉（uiStore.stackDrawerNodeId）。
 *  - 展开 = **屏幕固定尺寸大面板**（portal 到 body，占屏幕右侧约 6 成宽、垂直居中——不随画布缩放变小；
 *    开抽屉时视口把节点平移到屏幕左中，节点与抽屉左右并排）；面板内 **N×N 平铺**（按数量自动切换：
 *    ≤4 张 2×2 / 5~9 张 3×3 / ≥10 张 4×4，新→旧），超出 N 行纵向滚动。
 *  - 抽屉内双击卡片 → 全屏灯箱查看（Lightbox，视频带完整控制条）；右击卡片 → 「设为主图」
 *    （主图显示在抽屉外、参与画布连线）。
 *  - 长按拖动卡片到抽屉外停留 1 秒 → 松开**复制**为新画布节点（原条目仍留在抽屉内，不是剪切）。
 *  - 点击抽屉/本节点以外的任何位置 → 收起抽屉（Esc / 角标再点 / 点空白同样收起；灯箱开着时豁免）。
 *  - 外部同类节点拖入堆叠的逆操作在 useCanvasDrag（悬停 1 秒松开并入）。
 *
 * 面板/右键菜单/拖动幽灵都是 fixed 定位 → 必须 createPortal 到 body（节点在 transform 容器内，
 * fixed 会被劫持）；无 backdrop-filter（§9）。
 */
import { useRef, useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useReactFlow } from "@xyflow/react";
import { Layers, X, Star, Film } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useUiStore } from "@/store/uiStore";
import { openLightbox, useLightboxStore } from "@/store/lightboxStore";
import { dispatchCommand } from "@/command/dispatch";
import { makeNode } from "@/canvas/nodeFactory";
import { getPlugin } from "./pluginRegistry";

/** 拖出抽屉外需持续停留的毫秒数（满后松开=复制出去） */
const DRAG_OUT_ARM_MS = 1000;
/** 判定为拖动（而非点击）的位移阈值 */
const DRAG_START_PX = 6;
/** 面板左缘（屏幕宽度占比）：节点被平移到 1/4 宽处，面板从其右侧展开到屏幕右缘 */
const PANEL_LEFT_RATIO = 0.36;
const PAD = 14;
const GAP = 12;

interface DragState {
	assetId: string;
	x: number;
	y: number;
	/** 已在抽屉外停满 1 秒：松开即复制出去 */
	armed: boolean;
	/** 当前是否在抽屉外 */
	outside: boolean;
}

export function StackDrawer({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const mainAssetId = node?.data.resultAssetId ?? null;
	const history = node?.data.resultHistory ?? [];
	const assets = useLibraryStore((s) => s.assets);
	const { screenToFlowPosition, setCenter, getViewport } = useReactFlow();

	// 展开时平移视口：节点移到屏幕**左中**（约 1/4 宽处），与右侧的屏幕空间面板左右并排。
	// getViewport 只在打开瞬间读一次（不订阅 viewport，遵守 §9 渲染规则），保持当前缩放。
	useEffect(() => {
		const n = useCanvasStore.getState().nodes[nodeId];
		if (!n) return;
		const { zoom } = getViewport();
		const cx = n.x + (n.w ?? 240) / 2;
		const cy = n.y + (n.h ?? 200) / 2;
		void setCenter(cx + (window.innerWidth * 0.25) / zoom, cy, { zoom, duration: 380 });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeId]);

	const containerRef = useRef<HTMLDivElement>(null);
	const [drag, setDrag] = useState<DragState | null>(null);
	const [menu, setMenu] = useState<{ assetId: string; x: number; y: number } | null>(null);

	// 点击抽屉/本节点以外的任何位置 → 收起（capture 阶段，portal 的菜单/幽灵层带 data 标记豁免）
	useEffect(() => {
		const onDocPointerDown = (e: PointerEvent) => {
			const t = e.target as HTMLElement | null;
			if (!t) return;
			if (useLightboxStore.getState().item) return; // 双击开的全屏灯箱在最顶层：其内点击不关抽屉
			if (containerRef.current?.contains(t)) return;
			if (t.closest?.("[data-stack-drawer-layer]")) return;
			if (t.closest?.(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`)) return; // 本节点（含角标开关）
			useUiStore.getState().setStackDrawerNodeId(null);
		};
		document.addEventListener("pointerdown", onDocPointerDown, true);
		return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
	}, [nodeId]);

	// 拖动过程的即时状态（pointermove 高频，不走 React 状态判定计时）
	const dragRef = useRef<{
		assetId: string;
		startX: number;
		startY: number;
		started: boolean;
		outside: boolean;
		armed: boolean;
		timer: ReturnType<typeof setTimeout> | null;
	} | null>(null);

	const clearOutTimer = () => {
		const d = dragRef.current;
		if (d?.timer) {
			clearTimeout(d.timer);
			d.timer = null;
		}
	};

	const endDrag = useCallback(() => {
		clearOutTimer();
		dragRef.current = null;
		setDrag(null);
	}, []);

	// 抽屉关闭/卸载时清理在途拖动
	useEffect(() => () => clearOutTimer(), []);

	const onItemPointerDown = (e: React.PointerEvent, assetId: string) => {
		if (e.button !== 0) return; // 右键留给菜单
		e.stopPropagation();
		// 指针捕获：让拖出抽屉外后 move/up 仍派发到条目上。个别指针状态下会抛 NotFoundError——
		// 吞掉即可（后续 move 事件仍会冒泡进来，最多是极端情况下拖出体验降级，不能让手势整个挂掉）。
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			/* 忽略：无有效指针捕获时按普通冒泡处理 */
		}
		dragRef.current = {
			assetId,
			startX: e.clientX,
			startY: e.clientY,
			started: false,
			outside: false,
			armed: false,
			timer: null,
		};
	};

	const onItemPointerMove = (e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		if (!d.started) {
			if (Math.abs(e.clientX - d.startX) < DRAG_START_PX && Math.abs(e.clientY - d.startY) < DRAG_START_PX) return;
			d.started = true;
		}
		e.stopPropagation();
		const rect = containerRef.current?.getBoundingClientRect();
		const outside = !rect
			? true
			: e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
		if (outside !== d.outside) {
			d.outside = outside;
			if (outside) {
				// 出抽屉：起 1 秒计时，满时若仍在外侧则武装（松开即复制）
				clearOutTimer();
				d.timer = setTimeout(() => {
					const cur = dragRef.current;
					if (cur && cur.outside) {
						cur.armed = true;
						setDrag((v) => (v ? { ...v, armed: true } : v));
					}
				}, DRAG_OUT_ARM_MS);
			} else {
				// 拖回抽屉内：计时清零、解除武装
				clearOutTimer();
				d.armed = false;
			}
		}
		setDrag({ assetId: d.assetId, x: e.clientX, y: e.clientY, armed: d.armed, outside });
	};

	const onItemPointerUp = (e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		if (d.started) e.stopPropagation();
		// 满 1 秒且松手在抽屉外 → 复制出抽屉（原条目保留，不是剪切）
		if (d.started && d.armed && d.outside) {
			const asset = useLibraryStore.getState().assets[d.assetId];
			if (asset) {
				const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
				const type = asset.kind === "video" ? "video.gen" : "image.gen";
				const newNode = makeNode(type, pos.x - 120, pos.y - 100);
				newNode.data.resultAssetId = d.assetId;
				newNode.data.resultHistory = [d.assetId];
				newNode.data.params = {
					...newNode.data.params,
					prompt: `复制自堆叠 · 「${asset.name || d.assetId}」`,
				};
				dispatchCommand({ type: "addNode", node: newNode });
			}
		}
		endDrag();
	};

	if (!node) return null;
	const display = getPlugin(node.type)?.displayKind;
	// 条目 = resultHistory ∪ 主图（老节点可能只有主图没 history）；平铺顺序：新→旧
	const merged = mainAssetId && !history.includes(mainAssetId) ? [...history, mainAssetId] : history;
	const items = [...merged].reverse();
	const dragAsset = drag ? assets[drag.assetId] : null;

	// 屏幕空间尺寸（不随画布缩放）：面板从 36% 宽处铺到右缘；N×N 平铺（列数=可视行数=N，
	// **按数量自动切换**：≤4 张 2×2 / 5~9 张 3×3 / ≥10 张 4×4），卡宽按面板宽 N 等分、16:9；
	// 超出 N 行纵向滚动（并受 72% 屏高上限约束）。
	const cols = merged.length >= 10 ? 4 : merged.length >= 5 ? 3 : 2;
	const panelLeft = Math.round(window.innerWidth * PANEL_LEFT_RATIO);
	const panelW = window.innerWidth - panelLeft - 24;
	const cardW = Math.floor((panelW - PAD * 2 - GAP * (cols - 1)) / cols);
	const cardH = Math.round((cardW * 9) / 16);
	const rows = Math.ceil(items.length / cols);
	const gridH = rows * cardH + Math.max(0, rows - 1) * GAP + PAD * 2;
	const viewH = cols * cardH + (cols - 1) * GAP + PAD * 2; // N 行可视高度
	const gridMaxH = Math.round(window.innerHeight * 0.72);
	const bodyH = Math.min(gridH, viewH, gridMaxH);
	// 垂直居中用像素 top（不用 transform，保持 fixed 定位纯粹）
	const panelTop = Math.max(24, Math.round((window.innerHeight - (bodyH + 64)) / 2));

	return createPortal(
		<div
			ref={containerRef}
			className="fixed z-[10100] flex flex-col rounded-2xl border border-white/15 shadow-2xl"
			style={{
				left: panelLeft,
				top: panelTop,
				width: panelW,
				background: "rgba(16, 20, 32, 0.97)",
			}}
			onDoubleClick={(e) => e.stopPropagation()}
			onContextMenu={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
			onPointerDown={(e) => e.stopPropagation()}
		>
			<div className="flex items-center justify-between px-3 py-2 border-b border-white/10 select-none shrink-0">
				<span className="flex items-center gap-1.5 text-xs font-semibold text-white/85">
					<Layers className="h-3.5 w-3.5" />
					堆叠（{merged.length}）
				</span>
				<div className="flex items-center gap-2">
					<span className="text-[10px] text-white/40 select-none">{cols}×{cols}</span>
					<button
						onClick={(e) => {
							e.stopPropagation();
							useUiStore.getState().setStackDrawerNodeId(null);
						}}
						className="rounded p-1 text-white/55 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
						title="收起抽屉（Esc / C / 点击其它位置）"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>

			{/* 平铺网格（新→旧，N×N，超出纵向滚动） */}
			<div className="overflow-y-auto overflow-x-hidden Qiji-scroll-thin" style={{ height: bodyH, padding: PAD }}>
				<div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: GAP }}>
					{items.map((id, i) => {
						const a = assets[id];
						if (!a) return null;
						const isMain = id === mainAssetId;
						// 序号 = 生成顺序（旧→新），items 是新→旧倒排
						const seq = merged.length - i;
						return (
							<div
								key={id}
								className={`relative overflow-hidden rounded-xl border-2 cursor-grab active:cursor-grabbing select-none ${
									isMain
										? "border-[color:var(--node-accent,#8b5cf6)]"
										: "border-white/15 hover:border-white/50"
								} ${drag?.assetId === id ? "opacity-40" : ""}`}
								style={{ height: cardH, background: "rgb(24,28,40)" }}
								title={`${a.name || id}\n双击全屏查看 · 右击菜单 · 长按拖到抽屉外停留 1 秒=复制为新节点`}
								onPointerDown={(e) => onItemPointerDown(e, id)}
								onPointerMove={onItemPointerMove}
								onPointerUp={onItemPointerUp}
								onPointerCancel={endDrag}
								onDoubleClick={(e) => {
									e.stopPropagation();
									openLightbox({ uri: a.uri, name: a.name, media: a.kind === "video" ? "video" : "image" });
								}}
								onContextMenu={(e) => {
									e.preventDefault();
									e.stopPropagation();
									setMenu({ assetId: id, x: e.clientX, y: e.clientY });
								}}
							>
								{a.kind === "video" ? (
									<video src={a.uri} muted preload="metadata" className="h-full w-full object-cover pointer-events-none" />
								) : (
									<img src={a.uri} className="h-full w-full object-cover pointer-events-none" draggable={false} />
								)}
								{/* 序号（生成顺序）与主图标记 */}
								<span
									className="absolute top-1.5 right-2 text-sm font-bold text-white/60 pointer-events-none select-none"
									style={{ textShadow: "0 1px 3px rgba(0,0,0,0.8)" }}
								>
									{seq}
								</span>
								{isMain && (
									<span className="absolute top-0 left-0 rounded-br-lg bg-[color:var(--node-accent,#8b5cf6)] px-1.5 py-0.5 text-[10px] text-white pointer-events-none">
										主图
									</span>
								)}
							</div>
						);
					})}
				</div>
			</div>

			<div className="px-3 py-1.5 text-[10px] leading-snug text-white/40 border-t border-white/10 select-none shrink-0">
				双击全屏 · 右击设为主{display === "video" ? "视频" : "图"} · 拖出抽屉停 1 秒复制 · 拖同类节点到本节点上停 1 秒并入
			</div>

			{/* 条目右键菜单（同为 fixed 顶层，带豁免标记防外点误关抽屉） */}
			{menu &&
				createPortal(
					<div data-stack-drawer-layer>
						<div
							className="fixed inset-0 z-[10500]"
							onClick={() => setMenu(null)}
							onContextMenu={(e) => {
								e.preventDefault();
								setMenu(null);
							}}
						/>
						<div
							className="Qiji-panel fixed z-[10501] w-32 rounded-xl p-1 text-xs text-foreground shadow-2xl"
							style={{ left: menu.x, top: menu.y }}
							onClick={(e) => e.stopPropagation()}
						>
							<button
								onClick={() => {
									dispatchCommand({ type: "setNodeResultAsset", nodeId, assetId: menu.assetId });
									setMenu(null);
								}}
								disabled={menu.assetId === mainAssetId}
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary cursor-pointer transition-colors disabled:opacity-45 disabled:cursor-default"
								title="设为主图：显示在抽屉外、参与画布连线"
							>
								<Star className="h-3.5 w-3.5 text-amber-300" />
								{menu.assetId === mainAssetId ? "当前主图" : "设为主图"}
							</button>
						</div>
					</div>,
					document.body,
				)}

			{/* 拖动幽灵（跟随指针的缩略图 + 状态提示） */}
			{drag &&
				dragAsset &&
				createPortal(
					<div
						data-stack-drawer-layer
						className="fixed z-[10600] pointer-events-none flex flex-col items-center gap-1"
						style={{ left: drag.x, top: drag.y, transform: "translate(-50%, -50%)" }}
					>
						<div
							className={`w-28 aspect-video overflow-hidden rounded-md border-2 shadow-2xl ${
								drag.armed ? "border-emerald-400" : drag.outside ? "border-amber-300/80" : "border-white/30"
							}`}
						>
							{dragAsset.kind === "video" ? (
								<div className="h-full w-full flex items-center justify-center bg-black/80">
									<Film className="h-5 w-5 text-white/70" />
								</div>
							) : (
								<img src={dragAsset.uri} className="h-full w-full object-cover" draggable={false} />
							)}
						</div>
						<span
							className={`rounded-full px-2 py-0.5 text-[10px] font-medium whitespace-nowrap shadow-lg ${
								drag.armed
									? "bg-emerald-500/90 text-white"
									: "bg-black/80 text-white/80 border border-white/15"
							}`}
						>
							{drag.armed ? "松开复制到画布" : drag.outside ? "抽屉外停留 1 秒后松开复制…" : "拖到抽屉外可复制"}
						</span>
					</div>,
					document.body,
				)}
		</div>,
		document.body,
	);
}
