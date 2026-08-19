/**
 * ShotGroupView —— 分镜组节点（shot.group）的节点体渲染。
 *
 *  - 宫格：固定 rows×cols 布局（图多于宫格自动增行），单格 cover 裁齐（无圆角）；
 *    空格「+」可点击 → 添加图片（本地上传 / 素材库选择，追加到宫格尾部，可撤销）。
 *  - 拖动排序：按住格子拖到目标格松开即重排（updateShotGroup 命令，可撤销）；双击格子=灯箱；
 *    右击格子=菜单（单独解除成独立图片节点 / 移出分镜组）。
 *  - 工具条（比例 / 宫格数 / 序号 / 拼接 / 清空 / 解组）不内嵌节点体：由 BaseNode 悬停工具栏
 *    渲染本文件导出的 ShotGroupToolbar（与 信息/删除 同一位置，随缩放反缩放——
 *    低缩放下仍可读可点，也不再挤占宫格/干扰节点边框）。
 *
 * 性能遵守 §9：不订阅 viewport；控件全部 nodrag + stopPropagation（不与节点拖拽打架）；
 * 格子菜单/素材库选择弹窗一律 portal 到 body（节点在 transform 容器内，fixed 弹层直渲会跑位）。
 */
import { useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Plus, Hash, Eraser, Ungroup, Loader2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore, type Asset } from "@/store/libraryStore";
import { uploadMediaToCanvasAsset } from "@/canvas/nodeUpload";
import { dispatchCommand } from "@/command/dispatch";
import { openLightbox } from "@/store/lightboxStore";
import { confirmDialog } from "@/lib/confirmDialog";
import {
	GRID_PRESETS, SHOT_RATIOS, SHOT_GRID_GAP, SHOT_GRID_PAD, GRID_MAX,
	parseRatio, shotGridOf, moveItem,
} from "@/lib/shotGroup";
import { useDisplayUri } from "./ResultView";

/** 按当前节点宽度反推新宫格/比例下的节点高度（宽度不变，只调高度；工具条已悬浮、不占体高） */
function heightFor(w: number, rows: number, cols: number, ratio: string): number {
	const cellW = (w - SHOT_GRID_PAD * 2 - (cols - 1) * SHOT_GRID_GAP) / cols;
	const cellH = cellW / parseRatio(ratio);
	return Math.max(120, Math.round(rows * cellH + (rows - 1) * SHOT_GRID_GAP + SHOT_GRID_PAD * 2));
}

export function ShotGroupView({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const [dragIdx, setDragIdx] = useState<number | null>(null);
	const [overIdx, setOverIdx] = useState<number | null>(null);
	const pressRef = useRef<{ idx: number; x: number; y: number; dragging: boolean } | null>(null);
	// 拖拽目标的权威值放 ref（state 仅供渲染高亮）：setState 更新器内做派发会被 StrictMode 双调用
	const overRef = useRef<number | null>(null);

	const assets = node?.data.shotAssets ?? [];
	const { rows, cols, showIndex } = shotGridOf(node ?? { data: { input: {}, params: {}, resultAssetId: null } });
	// 图多于宫格：自动增行显示（不丢图）
	const shownRows = Math.max(rows, Math.ceil(assets.length / cols) || rows);
	const slots = shownRows * cols;

	// 格子右键菜单 / 空格「添加」菜单 / 素材库选择弹窗 / 本地上传进行中
	const [cellMenu, setCellMenu] = useState<{ x: number; y: number; idx: number } | null>(null);
	const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
	const [libPickOpen, setLibPickOpen] = useState(false);
	const [adding, setAdding] = useState(false);

	/** 追加图片资产到宫格尾部（空格填充顺序即资产序，可撤销） */
	const appendAssets = useCallback(
		(ids: string[]) => {
			if (ids.length === 0) return;
			const now = useCanvasStore.getState().nodes[nodeId]?.data.shotAssets ?? [];
			dispatchCommand({ type: "updateShotGroup", nodeId, assets: [...now, ...ids] });
		},
		[nodeId],
	);

	/** 本地上传：多选图片 → 逐个上传 OSS+登记素材库（与拼接/切分产物同形态）→ 追加进宫格 */
	const addLocalFiles = useCallback(() => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "image/*";
		input.multiple = true;
		input.onchange = () => {
			const files = [...(input.files ?? [])].filter((f) => f.type.startsWith("image/"));
			if (files.length === 0) return;
			setAdding(true);
			void (async () => {
				const ids: string[] = [];
				try {
					for (const f of files) {
						const up = await uploadMediaToCanvasAsset(f, "TP");
						useLibraryStore.getState().addAsset({
							id: up.assetId,
							kind: "image",
							name: f.name,
							uri: up.displayUri,
							serverAssetId: up.assetId,
							thumbnailUri: null,
							createdAt: new Date().toISOString(),
							deletedByUser: false,
							localPath: up.localPath,
						});
						ids.push(up.assetId);
					}
				} catch (err) {
					alert(`上传失败：${err instanceof Error ? err.message : "未知错误"}${ids.length ? `（已成功 ${ids.length} 张将加入宫格）` : ""}`);
				} finally {
					appendAssets(ids);
					setAdding(false);
				}
			})();
		};
		input.click();
	}, [appendAssets]);

	/** 格子右键：单独解除 / 移出分镜组 */
	const onCellCtxMenu = useCallback((e: React.MouseEvent, idx: number) => {
		e.preventDefault();
		e.stopPropagation();
		setCellMenu({ x: e.clientX, y: e.clientY, idx });
	}, []);

	// ── 拖动排序：按住格子（>6px 起拖），拖到目标格松开即重排 ──
	const onCellPointerDown = (e: React.PointerEvent, idx: number) => {
		if (e.button !== 0 || idx >= assets.length) return;
		e.stopPropagation();
		pressRef.current = { idx, x: e.clientX, y: e.clientY, dragging: false };
		const onMove = (me: PointerEvent) => {
			const p = pressRef.current;
			if (!p) return;
			if (!p.dragging) {
				if (Math.abs(me.clientX - p.x) + Math.abs(me.clientY - p.y) < 6) return;
				p.dragging = true;
				setDragIdx(p.idx);
			}
			const el = (document.elementFromPoint(me.clientX, me.clientY) as HTMLElement | null)?.closest(
				`[data-shot-node="${CSS.escape(nodeId)}"][data-shot-idx]`,
			) as HTMLElement | null;
			const over = el ? parseInt(el.dataset.shotIdx || "", 10) : NaN;
			const val = Number.isFinite(over) && over < assets.length ? over : null;
			overRef.current = val;
			setOverIdx(val);
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			const p = pressRef.current;
			const cur = overRef.current;
			pressRef.current = null;
			overRef.current = null;
			setDragIdx(null);
			setOverIdx(null);
			if (p?.dragging && cur !== null && cur !== p.idx) {
				const now = useCanvasStore.getState().nodes[nodeId]?.data.shotAssets ?? [];
				const next = moveItem(now, p.idx, cur);
				if (next !== now) dispatchCommand({ type: "updateShotGroup", nodeId, assets: next });
			}
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	if (!node) return null;

	return (
		<div className="Qiji-result Qiji-result--filled w-full h-full" onDoubleClick={(e) => e.stopPropagation()}>
			{/* 宫格（工具条见 ShotGroupToolbar，由 BaseNode 悬停工具栏渲染） */}
			<div
				className="w-full h-full grid"
				style={{
					gridTemplateColumns: `repeat(${cols}, 1fr)`,
					gridTemplateRows: `repeat(${shownRows}, 1fr)`,
					gap: SHOT_GRID_GAP,
					padding: SHOT_GRID_PAD,
				}}
			>
				{Array.from({ length: slots }, (_, i) => {
					const aid = assets[i];
					if (!aid) {
						const busy = adding && i === assets.length; // 上传中：第一个空格转圈
						return (
							<button
								key={`empty-${i}`}
								className="nodrag border border-dashed border-white/12 flex items-center justify-center text-muted-foreground/50 hover:text-foreground/80 hover:border-white/30 transition-colors select-none min-h-0 min-w-0 cursor-pointer bg-transparent"
								title="添加图片（本地上传 / 素材库选择）"
								onPointerDown={(e) => e.stopPropagation()}
								onClick={(e) => {
									e.stopPropagation();
									setAddMenu({ x: e.clientX, y: e.clientY });
								}}
							>
								{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
							</button>
						);
					}
					return (
						<ShotCell
							key={`${aid}-${i}`}
							nodeId={nodeId}
							assetId={aid}
							idx={i}
							showIndex={showIndex}
							dimmed={dragIdx === i}
							highlighted={overIdx === i && dragIdx !== null && dragIdx !== i}
							onPointerDown={onCellPointerDown}
							onCtxMenu={onCellCtxMenu}
						/>
					);
				})}
			</div>

			{/* 格子右键菜单：单独解除 / 移出分镜组 */}
			{cellMenu && (
				<FloatMenu
					x={cellMenu.x}
					y={cellMenu.y}
					onClose={() => setCellMenu(null)}
					items={[
						{
							label: "单独解除（变回图片节点）",
							onClick: () => dispatchCommand({ type: "extractShotGroupItem", nodeId, index: cellMenu.idx }),
						},
						{
							label: "移出分镜组",
							danger: true,
							onClick: () => {
								const now = useCanvasStore.getState().nodes[nodeId]?.data.shotAssets ?? [];
								dispatchCommand({ type: "updateShotGroup", nodeId, assets: now.filter((_, i) => i !== cellMenu.idx) });
							},
						},
					]}
				/>
			)}

			{/* 空格「添加」菜单：本地上传 / 素材库选择 */}
			{addMenu && (
				<FloatMenu
					x={addMenu.x}
					y={addMenu.y}
					onClose={() => setAddMenu(null)}
					items={[
						{ label: "本地上传…", onClick: addLocalFiles },
						{ label: "从素材库选择…", onClick: () => setLibPickOpen(true) },
					]}
				/>
			)}

			{/* 素材库图片多选弹窗 */}
			{libPickOpen && (
				<LibraryPickModal
					onClose={() => setLibPickOpen(false)}
					onAdd={(ids) => {
						setLibPickOpen(false);
						appendAssets(ids);
					}}
				/>
			)}
		</div>
	);
}

/** 轻量浮动菜单（portal 到 body：节点在 transform 容器内，fixed 直渲会跑位——§9 规则） */
function FloatMenu({
	x,
	y,
	onClose,
	items,
}: {
	x: number;
	y: number;
	onClose: () => void;
	items: { label: string; danger?: boolean; onClick: () => void }[];
}) {
	return createPortal(
		<div
			className="fixed inset-0"
			style={{ zIndex: 10600 }}
			onClick={onClose}
			onContextMenu={(e) => {
				e.preventDefault();
				onClose();
			}}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
		>
			<div
				className="absolute min-w-[168px] rounded-lg border border-white/10 py-1 shadow-2xl"
				style={{
					left: Math.min(x, window.innerWidth - 190),
					top: Math.min(y, window.innerHeight - items.length * 32 - 16),
					background: "rgba(18, 22, 34, 0.97)",
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{items.map((it) => (
					<button
						key={it.label}
						className={`w-full text-left px-3 py-1.5 text-[12px] transition-colors cursor-pointer ${
							it.danger ? "text-destructive hover:bg-destructive/10" : "text-foreground/90 hover:bg-white/8"
						}`}
						onClick={() => {
							onClose();
							it.onClick();
						}}
					>
						{it.label}
					</button>
				))}
			</div>
		</div>,
		document.body,
	);
}

/** 素材库图片多选弹窗（portal 到 body；仅列未删除的图片资产，新→旧） */
function LibraryPickModal({ onClose, onAdd }: { onClose: () => void; onAdd: (ids: string[]) => void }) {
	const assetsMap = useLibraryStore((s) => s.assets);
	const [sel, setSel] = useState<string[]>([]);
	const list = useMemo(() => {
		const ts = (a: Asset) => {
			const t = Date.parse(String(a.createdAt));
			return Number.isFinite(t) ? t : 0;
		};
		return Object.values(assetsMap)
			.filter((a) => a.kind === "image" && !!a.uri && !a.deletedByUser)
			.sort((a, b) => ts(b) - ts(a));
	}, [assetsMap]);

	const toggle = (id: string) =>
		setSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center"
			style={{ zIndex: 10600, background: "rgba(0, 0, 0, 0.5)" }}
			onClick={onClose}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
		>
			<div
				className="rounded-xl border border-white/10 shadow-2xl flex flex-col"
				style={{ width: 560, maxHeight: "68vh", background: "#12151c" }}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between px-4 py-3 border-b border-white/8">
					<span className="text-[13px] font-medium text-foreground">从素材库选择图片</span>
					<span className="text-[11px] text-muted-foreground">点击图片多选，按选择顺序加入宫格</span>
				</div>
				<div className="flex-1 min-h-0 overflow-y-auto Qiji-scroll-thin p-3">
					{list.length === 0 ? (
						<div className="py-10 text-center text-[12px] text-muted-foreground">素材库暂无图片</div>
					) : (
						<div className="grid grid-cols-4 gap-2">
							{list.map((a) => (
								<PickThumb key={a.id} asset={a} order={sel.indexOf(a.id)} onToggle={() => toggle(a.id)} />
							))}
						</div>
					)}
				</div>
				<div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-white/8">
					<button
						className="rounded-md px-3 py-1.5 text-[12px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer"
						onClick={onClose}
					>
						取消
					</button>
					<button
						className="rounded-md px-3 py-1.5 text-[12px] bg-primary text-primary-foreground disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
						disabled={sel.length === 0}
						onClick={() => onAdd(sel)}
					>
						添加（{sel.length}）
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}

/** 素材库弹窗里的缩略图（显示 uri 走 useDisplayUri，与全站媒体显示同一把尺） */
function PickThumb({ asset, order, onToggle }: { asset: Asset; order: number; onToggle: () => void }) {
	const uri = useDisplayUri(asset.uri);
	const selected = order >= 0;
	return (
		<button
			className={`relative aspect-video overflow-hidden bg-black/40 cursor-pointer transition-shadow ${
				selected ? "ring-2 ring-primary" : "hover:ring-1 hover:ring-white/30"
			}`}
			title={asset.name}
			onClick={onToggle}
		>
			{uri ? (
				<img src={uri} alt={asset.name} className="w-full h-full object-cover pointer-events-none" draggable={false} loading="lazy" />
			) : (
				<span className="w-full h-full flex items-center justify-center text-[10px] text-muted-foreground/60">加载中…</span>
			)}
			{selected && (
				<span className="absolute right-1 top-1 rounded bg-primary px-1.5 py-[1px] text-[10px] font-semibold text-primary-foreground leading-tight">
					{order + 1}
				</span>
			)}
			<span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-[2px] text-left text-[9px] text-white/85">
				{asset.name}
			</span>
		</button>
	);
}

/**
 * ShotGroupToolbar —— 分镜组悬浮工具条（比例 / 宫格数 / 序号 / 拼接 / 清空 / 解组）。
 * 由 BaseNode 悬停工具栏渲染，与 面板/信息/删除 同排同位置（随缩放反缩放，低缩放仍可读）。
 * 下拉 onChange 后主动 blur：配合 BaseNode 的「select 聚焦期间不收起」守卫释放悬停态。
 */
export function ShotGroupToolbar({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const [stitching, setStitching] = useState(false);

	const setParams = useCallback(
		(patch: Record<string, unknown>) => dispatchCommand({ type: "updateNodeParams", id: nodeId, params: patch }),
		[nodeId],
	);

	/** 改宫格/比例：写参数 + 按当前宽度重算节点高度（一次 resize 命令，可撤销） */
	const applyLayout = useCallback(
		(nr: number, nc: number, nRatio: string) => {
			setParams({ gridRows: nr, gridCols: nc, ratio: nRatio });
			const n = useCanvasStore.getState().nodes[nodeId];
			if (n) dispatchCommand({ type: "resizeNode", id: nodeId, w: n.w, h: heightFor(n.w, nr, nc, nRatio) });
		},
		[nodeId, setParams],
	);

	if (!node) return null;

	const assets = node.data.shotAssets ?? [];
	const { rows, cols, ratio, showIndex } = shotGridOf(node);

	const onGridChange = (v: string) => {
		if (v === "__custom") {
			const input = window.prompt(`自定义宫格（行x列，1-${GRID_MAX}），如 2x5：`, `${rows}x${cols}`);
			if (!input) return;
			const m = input.match(/^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i);
			if (!m) { alert("格式不对：请输入 行x列，如 2x5"); return; }
			const nr = Math.min(GRID_MAX, Math.max(1, parseInt(m[1], 10)));
			const nc = Math.min(GRID_MAX, Math.max(1, parseInt(m[2], 10)));
			applyLayout(nr, nc, ratio);
			return;
		}
		const [nr, nc] = v.split("×").map((s) => parseInt(s, 10));
		if (nr >= 1 && nc >= 1) applyLayout(nr, nc, ratio);
	};

	const onStitch = async (outW: 2048 | 4096) => {
		if (stitching || assets.length === 0) return;
		setStitching(true);
		try {
			const { stitchShotGroup } = await import("@/canvas/shotGroupOps");
			await stitchShotGroup(nodeId, outW);
		} catch (err) {
			alert(`拼接失败：${err instanceof Error ? err.message : "未知错误"}`);
		} finally {
			setStitching(false);
		}
	};

	const gridLabel = `${rows}×${cols}`;
	const gridOptions = GRID_PRESETS.some((p) => p.label === gridLabel)
		? GRID_PRESETS.map((p) => p.label)
		: [gridLabel, ...GRID_PRESETS.map((p) => p.label)];
	const ratioOptions = SHOT_RATIOS.includes(ratio) ? SHOT_RATIOS : [ratio, ...SHOT_RATIOS];

	const selCls =
		"nodrag h-6 rounded-md border border-white/10 bg-white/5 px-1 text-[10px] text-foreground outline-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed";
	const btnCls =
		"nodrag flex items-center gap-1 rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/8 transition-colors cursor-pointer whitespace-nowrap shrink-0";

	return (
		<div
			className="flex items-center gap-1 shrink-0"
			onPointerDown={(e) => e.stopPropagation()}
			onClick={(e) => e.stopPropagation()}
		>
			<select
				className={selCls}
				value={ratio}
				onChange={(e) => { applyLayout(rows, cols, e.target.value); e.target.blur(); }}
				title="单格比例（决定节点形状）"
			>
				{ratioOptions.map((r) => (
					<option key={r} value={r}>{r}</option>
				))}
			</select>
			<select
				className={selCls}
				value={gridLabel}
				onChange={(e) => { onGridChange(e.target.value); e.target.blur(); }}
				title="修改分镜组宫格数量"
			>
				{gridOptions.map((g) => (
					<option key={g} value={g}>宫格 {g}</option>
				))}
				<option value="__custom">自定义…</option>
			</select>
			<button className={`${btnCls} ${showIndex ? "!text-primary" : ""}`} onClick={() => setParams({ showIndex: !showIndex })} title="显示/隐藏宫格序号">
				<Hash className="h-3 w-3 shrink-0" />序号
			</button>
			{/* 拼接：动作下拉（2k=2048 / 4k=4096 宽），选中即执行、随后复位占位项 */}
			<select
				className={selCls}
				value=""
				disabled={stitching || assets.length === 0}
				onChange={(e) => {
					const w = Number(e.target.value);
					e.target.value = "";
					e.target.blur();
					if (w === 2048 || w === 4096) void onStitch(w);
				}}
				title="按宫格布局拼接成一张大图（选 2k/4k 输出宽度，右侧新图片节点承载）"
			>
				<option value="" hidden>{stitching ? "拼接中" : "拼接"}</option>
				<option value="2048">拼接 2k</option>
				<option value="4096">拼接 4k</option>
			</select>
			<button
				className={btnCls}
				onClick={() => {
					if (assets.length === 0) return;
					void (async () => {
						if (await confirmDialog(`清空分镜组内全部 ${assets.length} 张图片？（图片资产仍在资产库，可撤销）`)) {
							dispatchCommand({ type: "updateShotGroup", nodeId, assets: [] });
						}
					})();
				}}
				title="清空宫格（资产不删，可撤销）"
			>
				<Eraser className="h-3 w-3 shrink-0" />清空
			</button>
			<button
				className={btnCls}
				onClick={() => dispatchCommand({ type: "dissolveShotGroup", nodeId })}
				title="解组：每张图变回独立图片节点（可撤销）"
			>
				<Ungroup className="h-3 w-3 shrink-0" />解组
			</button>
		</div>
	);
}

function ShotCell({
	nodeId,
	assetId,
	idx,
	showIndex,
	dimmed,
	highlighted,
	onPointerDown,
	onCtxMenu,
}: {
	nodeId: string;
	assetId: string;
	idx: number;
	showIndex: boolean;
	dimmed: boolean;
	highlighted: boolean;
	onPointerDown: (e: React.PointerEvent, idx: number) => void;
	onCtxMenu: (e: React.MouseEvent, idx: number) => void;
}) {
	const asset = useLibraryStore((s) => s.assets[assetId] ?? null);
	const uri = useDisplayUri(asset?.uri ?? "");
	return (
		<div
			data-shot-node={nodeId}
			data-shot-idx={idx}
			className={`nodrag relative overflow-hidden bg-black/30 min-h-0 min-w-0 cursor-grab select-none transition-opacity ${dimmed ? "opacity-40" : ""
				} ${highlighted ? "ring-2 ring-primary" : ""}`}
			title="按住拖动排序 · 双击放大 · 右击菜单"
			onPointerDown={(e) => onPointerDown(e, idx)}
			onContextMenu={(e) => onCtxMenu(e, idx)}
			onDoubleClick={(e) => {
				e.stopPropagation();
				if (uri) openLightbox({ uri, name: asset?.name, media: "image" });
			}}
		>
			{uri ? (
				<img src={uri} alt={asset?.name} className="w-full h-full object-cover pointer-events-none" draggable={false} />
			) : (
				<div className="w-full h-full flex items-center justify-center text-[9px] text-muted-foreground/60">加载中…</div>
			)}
			{showIndex && (
				<span className="absolute left-1 top-1 rounded bg-black/65 px-1 py-[1px] text-[9px] font-semibold text-white/90 leading-none pointer-events-none">
					{idx + 1}
				</span>
			)}
		</div>
	);
}
