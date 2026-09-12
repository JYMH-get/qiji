import { useEffect, useRef, useState } from "react";
import { ChevronDown, Map, Grid, Layers, Magnet, X } from "lucide-react";
import { useUiStore } from "@/store/uiStore";
import { useProjectStore } from "@/store/projectStore";
import { confirmDialog } from "@/lib/confirmDialog";

/**
 * 分集切换下拉（自定义，替代原生 <select>）：原生 select 的选项里放不了按钮——
 * 用户要求分集「可增可删」，故改为自定义下拉，每行带 × 删除键（悬停显现）。
 * 删除语义与表格模式（Frame161195 deleteEp）完全一致：confirmDialog 确认 →
 * projectStore.deleteEpisode（至少保留一集；删的是激活画布则先切走；连同该集画布数据一并丢弃）。
 */
function EpisodeSwitcher() {
	const episodes = useProjectStore((s) => s.episodes);
	const canvasEpisodeId = useProjectStore((s) => s.canvasEpisodeId);
	const switchCanvas = useProjectStore((s) => s.switchCanvas);
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	// 点击下拉外 / Esc 关闭
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (episodes.length === 0) return null;
	const activeId = canvasEpisodeId ?? episodes[0]?.id ?? "";
	const active = episodes.find((e) => e.id === activeId) ?? episodes[0];

	const onDelete = async (ep: { id: string; title: string }) => {
		if (episodes.length <= 1) {
			alert("至少保留一集，无法删除最后一个分集。");
			return;
		}
		if (!(await confirmDialog(`删除分集「${ep.title}」？将一并移除本集全部分镜、提示词与该集画布，操作不可撤销。`))) return;
		useProjectStore.getState().deleteEpisode(ep.id);
	};

	return (
		<div ref={wrapRef} className="relative">
			<button
				onClick={() => setOpen((v) => !v)}
				title="切换画布分集（每个分集是一块独立画布；同步用视频界面的「同步本集到画布」）"
				className="flex h-6 max-w-[160px] items-center gap-1 rounded border border-border/60 bg-secondary px-1.5 text-[11px] text-foreground outline-none cursor-pointer hover:border-primary transition-colors"
			>
				<span className="truncate">{active?.title}</span>
				<ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
			</button>
			{open && (
				<div className="absolute left-0 top-full z-[10160] mt-1 max-h-[50vh] w-max min-w-full max-w-[220px] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-lg">
					{episodes.map((ep) => (
						<div
							key={ep.id}
							onClick={() => {
								switchCanvas(ep.id);
								setOpen(false);
							}}
							className={`group flex cursor-pointer items-center gap-1 px-2 py-1 text-[11px] hover:bg-secondary ${
								ep.id === activeId ? "text-primary font-medium" : "text-foreground"
							}`}
						>
							<span className="flex-1 truncate">{ep.title}</span>
							{episodes.length > 1 && (
								<button
									onClick={(e) => {
										e.stopPropagation();
										void onDelete(ep);
									}}
									title={`删除分集「${ep.title}」（连同本集分镜与该集画布，不可撤销）`}
									className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
								>
									<X className="h-3 w-3" />
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** 顶部居中画布菜单。节点本地参考不在这里沉淀或二次复用。 */
export function AssetPanel() {
	const showGrid = useUiStore((s) => s.showGrid);
	const toggleShowGrid = useUiStore((s) => s.toggleShowGrid);
	const showMinimap = useUiStore((s) => s.showMinimap);
	const toggleMinimap = useUiStore((s) => s.toggleMinimap);
	const allowOverlap = useUiStore((s) => s.allowOverlap);
	const toggleAllowOverlap = useUiStore((s) => s.toggleAllowOverlap);
	const snapAlign = useUiStore((s) => s.snapAlign);
	const toggleSnapAlign = useUiStore((s) => s.toggleSnapAlign);

	// 画布内直接添加分集（实为新建一块独立画布；分集同时出现在视频界面分集列表——单数据源）
	const onAddEpisode = () => {
		const st = useProjectStore.getState();
		const n = st.episodes.length + 1;
		const input = window.prompt("新分集名称：", `第${n}集`);
		if (input === null) return; // 取消
		const id = st.addEpisode({ title: input.trim() || `第${n}集` });
		st.switchCanvas(id); // 建完即切到新画布
	};

	return (
		<div className="Qiji-asset pointer-events-auto absolute left-1/2 top-4 z-[10100] -translate-x-1/2 rounded-2xl px-3 py-2">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				{/* 分集选择器：切换当前画布分集（每集独立画布、互不影响、不卡）；纯切换不同步；行内 × 可删单集 */}
				<div className="flex items-center gap-1">
					<EpisodeSwitcher />
					{/* ＋ 添加分集 = 新建一块独立画布（分集同时出现在视频界面分集列表） */}
					<button
						onClick={onAddEpisode}
						title="添加分集（新建一块独立画布；分集同时出现在视频界面分集列表）"
						className="flex h-6 shrink-0 items-center rounded border border-border/60 bg-secondary px-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-primary cursor-pointer transition-colors"
					>
						＋分集
					</button>
				</div>

				{/* 交互控制开关组 */}
				<div className="flex items-center gap-1 border-r border-border/40 pr-2 mr-0.5">
					<button
						onClick={toggleMinimap}
						className={`flex h-6 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary cursor-pointer transition-colors ${
							showMinimap ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
						}`}
						title="小地图开关"
					>
						<Map className="h-3.5 w-3.5" />
						<span className="hidden sm:inline">小地图</span>
					</button>

					<button
						onClick={toggleSnapAlign}
						className={`flex h-6 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary cursor-pointer transition-colors ${
							snapAlign ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
						}`}
						title="节点吸附对齐开关（开=拖动节点时自动对齐其它节点的边缘/中线）"
					>
						<Magnet className="h-3.5 w-3.5" />
						<span className="hidden sm:inline">吸附</span>
					</button>

					<button
						onClick={toggleAllowOverlap}
						className={`flex h-6 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary cursor-pointer transition-colors ${
							allowOverlap ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
						}`}
						title="节点重叠开关（开=拖拽落子/新建节点不再自动避让，可自由堆叠）"
					>
						<Layers className="h-3.5 w-3.5" />
						<span className="hidden sm:inline">重叠</span>
					</button>

					<button
						onClick={toggleShowGrid}
						className={`flex h-6 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary cursor-pointer transition-colors ${
							showGrid ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
						}`}
						title="网格显隐开关（画布背景点阵）"
					>
						<Grid className="h-3.5 w-3.5" />
						<span className="hidden sm:inline">网格</span>
					</button>
				</div>

			</div>
		</div>
	);
}
