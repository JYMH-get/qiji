/**
 * GridSplitModal —— 图片宫格切分弹窗（仿 ClipPickerModal 观感，portal 到 body）。
 *
 * 选宫格数（2×2/3×3/4×4/5×5/自定义行列）→ 图片上叠宫格，点选要切出的格（≥1，可多选，
 * 格上标 行-列）→「创建分镜组」把选中格裁剪落库、右侧生成分镜组节点（调用方执行）。
 */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X, Grid3x3 } from "lucide-react";
import { GRID_MAX } from "@/lib/shotGroup";
import { useDisplayUri } from "@/nodes/ResultView";

const PRESETS: { label: string; rows: number; cols: number }[] = [
	{ label: "4宫格 (2×2)", rows: 2, cols: 2 },
	{ label: "9宫格 (3×3)", rows: 3, cols: 3 },
	{ label: "16宫格 (4×4)", rows: 4, cols: 4 },
	{ label: "25宫格 (5×5)", rows: 5, cols: 5 },
];

export default function GridSplitModal({
	uri,
	sourceName,
	onCancel,
	onConfirm,
}: {
	uri: string;
	sourceName?: string;
	onCancel: () => void;
	onConfirm: (rows: number, cols: number, cells: { r: number; c: number }[], trimBorder: boolean) => void;
}) {
	const displayUri = useDisplayUri(uri);
	const [rows, setRows] = useState(2);
	const [cols, setCols] = useState(2);
	const [custom, setCustom] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	// 去白边（缺省开）：逐格自动裁掉宫格间边框留白（均匀色边有效；装饰性边框请关掉按原样切）
	const [trimBorder, setTrimBorder] = useState(true);

	const setGrid = (r: number, c: number, isCustom = false) => {
		setRows(r);
		setCols(c);
		setCustom(isCustom);
		setSelected(new Set()); // 换宫格清空选择
	};

	const cells = useMemo(
		() =>
			[...selected]
				.map((k) => {
					const [r, c] = k.split("-").map(Number);
					return { r, c };
				})
				.sort((a, b) => (a.r === b.r ? a.c - b.c : a.r - b.r)),
		[selected],
	);

	const toggle = (r: number, c: number) => {
		const k = `${r}-${c}`;
		setSelected((s) => {
			const next = new Set(s);
			if (next.has(k)) next.delete(k);
			else next.add(k);
			return next;
		});
	};

	const clampDim = (v: string, d: number) => {
		const n = Math.round(Number(v));
		return Number.isFinite(n) ? Math.min(GRID_MAX, Math.max(1, n)) : d;
	};

	return createPortal(
		<div
			className="fixed inset-0 z-[10500] flex items-center justify-center bg-black/60 backdrop-blur-sm"
			onClick={onCancel}
			onContextMenu={(e) => e.preventDefault()}
		>
			<div
				className="Qiji-panel flex flex-col w-[640px] max-w-[92vw] max-h-[88vh] rounded-2xl text-foreground shadow-2xl border border-white/10 overflow-hidden"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div className="flex items-center justify-between px-5 pt-4 pb-2 shrink-0">
					<div className="flex items-center gap-2">
						<Grid3x3 className="h-4 w-4 text-primary" />
						<span className="text-sm font-semibold">宫格切分{sourceName ? ` · ${sourceName}` : ""}</span>
					</div>
					<button onClick={onCancel} className="text-muted-foreground hover:text-foreground hover:bg-secondary rounded-lg p-1 cursor-pointer transition-colors">
						<X className="h-4 w-4" />
					</button>
				</div>

				{/* 宫格数选择 */}
				<div className="flex items-center gap-1.5 px-5 pb-2 shrink-0 flex-wrap">
					{PRESETS.map((p) => (
						<button
							key={p.label}
							onClick={() => setGrid(p.rows, p.cols)}
							className={`rounded-lg border px-2.5 py-1 text-[11px] cursor-pointer transition-colors ${
								!custom && rows === p.rows && cols === p.cols
									? "border-primary text-primary bg-primary/10"
									: "border-border/50 text-muted-foreground hover:text-foreground bg-secondary/60"
							}`}
						>
							{p.label}
						</button>
					))}
					<button
						onClick={() => setGrid(rows, cols, true)}
						className={`rounded-lg border px-2.5 py-1 text-[11px] cursor-pointer transition-colors ${
							custom ? "border-primary text-primary bg-primary/10" : "border-border/50 text-muted-foreground hover:text-foreground bg-secondary/60"
						}`}
					>
						自定义
					</button>
					{custom && (
						<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
							<input
								type="number" min={1} max={GRID_MAX} value={rows}
								onChange={(e) => setGrid(clampDim(e.target.value, rows), cols, true)}
								className="w-12 h-6 rounded border border-border/50 bg-secondary/70 px-1.5 text-foreground outline-none focus:border-primary"
							/>
							行 ×
							<input
								type="number" min={1} max={GRID_MAX} value={cols}
								onChange={(e) => setGrid(rows, clampDim(e.target.value, cols), true)}
								className="w-12 h-6 rounded border border-border/50 bg-secondary/70 px-1.5 text-foreground outline-none focus:border-primary"
							/>
							列
						</span>
					)}
				</div>

				{/* 图片 + 宫格点选 */}
				<div className="flex-1 min-h-0 overflow-auto Qiji-scroll-thin px-5 pb-2 flex items-center justify-center">
					{displayUri ? (
						<div className="relative inline-block">
							<img src={displayUri} alt={sourceName} className="block max-w-full max-h-[56vh] rounded-lg select-none" draggable={false} />
							<div
								className="absolute inset-0 grid"
								style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}
							>
								{Array.from({ length: rows * cols }, (_, i) => {
									const r = Math.floor(i / cols);
									const c = i % cols;
									const on = selected.has(`${r}-${c}`);
									return (
										<button
											key={i}
											onClick={() => toggle(r, c)}
											title={`${r + 1}-${c + 1}`}
											className={`relative border border-white/35 cursor-pointer transition-colors ${
												on ? "bg-primary/35 border-primary" : "hover:bg-white/10"
											}`}
										>
											<span
												className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-[11px] font-semibold leading-none pointer-events-none ${
													on ? "bg-primary text-primary-foreground" : "bg-black/55 text-white/85"
												}`}
											>
												{r + 1}-{c + 1}
											</span>
										</button>
									);
								})}
							</div>
						</div>
					) : (
						<span className="text-[11px] text-muted-foreground py-10">图片加载中…</span>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border/40 shrink-0">
					<div className="flex items-center gap-3 min-w-0">
						<label
							className="flex items-center gap-1.5 text-[11px] text-foreground/90 cursor-pointer select-none shrink-0"
							title="自动裁掉每格四周的边框留白（按格子边缘采样背景色，均匀色边框有效；装饰性/多彩边框请关掉按原样切）"
						>
							<input
								type="checkbox"
								checked={trimBorder}
								onChange={(e) => setTrimBorder(e.target.checked)}
								className="accent-[var(--primary,#8b7cf7)] cursor-pointer"
							/>
							去白边
						</label>
						<span className="text-[10px] text-muted-foreground truncate">
							已选 {cells.length} 个宫格（点击宫格选择/取消，至少选 1 个）
						</span>
					</div>
					<div className="flex items-center gap-2 shrink-0">
						<button onClick={onCancel} className="px-4 py-1.5 rounded-lg bg-secondary text-foreground hover:bg-secondary/80 text-xs cursor-pointer transition-colors">
							取消
						</button>
						<button
							onClick={() => onConfirm(rows, cols, cells, trimBorder)}
							disabled={cells.length === 0}
							className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 text-xs cursor-pointer transition-colors disabled:opacity-45 disabled:cursor-not-allowed"
						>
							创建分镜组
						</button>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
