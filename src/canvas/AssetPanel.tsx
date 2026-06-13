import { Images, ChevronUp, ChevronDown, Wand2, Map, Grid, Music, FileText } from "lucide-react";
import { useLibraryStore } from "@/store/libraryStore";
import { useUiStore } from "@/store/uiStore";
import { autoLayoutCanvas } from "@/lib/layout";

/** 顶部居中素材面板：展示本项目已生成资产（当前为空态占位）。 */
export function AssetPanel() {
	const open = useUiStore((s) => s.assetPanelOpen);
	const toggle = useUiStore((s) => s.toggleAssetPanel);
	const snapToGrid = useUiStore((s) => s.snapToGrid);
	const toggleSnapToGrid = useUiStore((s) => s.toggleSnapToGrid);
	const showMinimap = useUiStore((s) => s.showMinimap);
	const toggleMinimap = useUiStore((s) => s.toggleMinimap);

	const assets = useLibraryStore((s) =>
		Object.values(s.assets).filter((a) => !a.deletedByUser),
	);
	return (
		<div className="Qiji-asset pointer-events-auto absolute left-1/2 top-4 z-20 w-[min(640px,calc(100%-160px))] -translate-x-1/2 rounded-2xl px-3 py-2">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Images className="h-4 w-4" />
				<span className="font-medium text-foreground">素材库</span>
				<span>{assets.length} 项</span>

				{/* 交互控制开关组 */}
				<div className="ml-auto flex items-center gap-1 border-r border-border/40 pr-2 mr-0.5">
					<button
						onClick={autoLayoutCanvas}
						className="flex h-6 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
						title="整理画布 (自动排版)"
					>
						<Wand2 className="h-3.5 w-3.5" />
						<span className="hidden sm:inline">整理</span>
					</button>

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
						onClick={toggleSnapToGrid}
						className={`flex h-6 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-secondary cursor-pointer transition-colors ${
							snapToGrid ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
						}`}
						title="网格吸附开关 (15px)"
					>
						<Grid className="h-3.5 w-3.5" />
						<span className="hidden sm:inline">网格</span>
					</button>
				</div>

				<button
					onClick={toggle}
					className="rounded p-0.5 hover:bg-secondary"
					aria-label="展开/收起"
				>
					{open ? (
						<ChevronUp className="h-4 w-4" />
					) : (
						<ChevronDown className="h-4 w-4" />
					)}
				</button>
			</div>
			{open ? (
				<div className="Qiji-scroll-thin mt-2 flex gap-2 overflow-x-auto pb-1">
					{assets.length === 0 ? (
						<span className="py-3 text-[11px] text-muted-foreground">
							运行节点生成后，产物会沉淀在这里（资产 ID 单调递增·仅用户可删）。
						</span>
					) : (
						assets.map((a) => (
							<div
								key={a.id}
								draggable
								onDragStart={(e) => {
									e.dataTransfer.setData("text/plain", JSON.stringify({ source: "library", assetId: a.id, kind: a.kind }));
									e.dataTransfer.effectAllowed = "copy";
								}}
								className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary font-mono text-[9px] text-muted-foreground cursor-grab hover:border-primary transition-colors overflow-hidden select-none"
								title={`${a.name} (${a.kind})`}
							>
								{a.kind === "image" && (
									<img
										src={a.uri}
										alt={a.name}
										className="h-full w-full object-cover rounded-lg pointer-events-none"
									/>
								)}
								{a.kind === "video" && (
									<video
										src={a.uri}
										className="h-full w-full object-cover rounded-lg pointer-events-none"
										preload="metadata"
										muted
									/>
								)}
								{a.kind === "audio" && (
									<div className="flex flex-col items-center justify-center text-center w-full h-full p-1 bg-secondary text-purple-400">
										<Music className="h-4.5 w-4.5 mb-0.5" />
										<span className="text-[7px] truncate max-w-full scale-90">{a.name}</span>
									</div>
								)}
								{a.kind === "script" && (
									<div className="flex flex-col items-center justify-center text-center w-full h-full p-1 bg-secondary text-emerald-400">
										<FileText className="h-4.5 w-4.5 mb-0.5" />
										<span className="text-[7px] truncate max-w-full scale-90">{a.name}</span>
									</div>
								)}
							</div>
						))
					)}
				</div>
			) : null}
		</div>
	);
}
