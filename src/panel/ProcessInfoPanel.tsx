/**
 * ProcessInfoPanel —— 处理类/只读结果节点的锁定面板（信息展示，不开放编辑）。
 * 覆盖：视频超分（video.upscale）/ 去字幕（video.desub）/ 图像超分（image.upscale）——按 params.purpose；
 *      分段等本地产物（params.resultOnly）——只展示 procLabel/procInfo，不可重跑。
 * OperationPanel / VideoOperationPanel 检测到上述节点时早退渲染本组件。
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import { motion } from "motion/react";
import { Play, Sparkles, Columns2 } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { dispatchCommand } from "@/command/dispatch";
import { optLabel } from "@/components/VideoProcessModal";
import MediaCompareModal from "@/components/MediaCompareModal";
import { isProcessNodeParams } from "@/lib/sharedNodeParams";

/** 该节点是否应使用锁定面板（判定单一来源：sharedNodeParams.isProcessNodeParams） */
export function isProcessResultNode(params: Record<string, unknown> | undefined): boolean {
	return isProcessNodeParams(params);
}

/** 显示 uri：远程 https 优先换本地副本（Tauri CSP 不允许 https 图直显）；无本地副本原样返回 */
function displayUriOf(uri: string): string {
	if (!/^https?:/i.test(uri)) return uri;
	return useProjectStore.getState().blobByUri(uri)?.localUri || uri;
}

const PROC_TITLES: Record<string, string> = {
	"video.upscale": "超分（画质增强）",
	"video.desub": "去字幕",
	"image.upscale": "图像超分（画质增强）",
};

export function ProcessInfoPanel({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const runtime = useCanvasStore((s) => s.runtime[nodeId]);
	const viewport = useCanvasStore((s) => s.viewport);
	const catModels = useCatalogStore((s) => s.catalog?.models);
	const [compareOpen, setCompareOpen] = useState(false);
	// 对比原素材（图像超分/视频超分/去字幕）：结果=本节点资产；原素材=上游连线第一个同模态结果资产
	const compare = useLibraryStore((s) => {
		const cs = useCanvasStore.getState();
		const n = cs.nodes[nodeId];
		const purpose = n?.data.params?.purpose;
		const media: "image" | "video" | null =
			purpose === "image.upscale" ? "image"
			: purpose === "video.upscale" || purpose === "video.desub" ? "video"
			: null;
		if (!media) return null;
		const after = n!.data.resultAssetId ? s.assets[n!.data.resultAssetId] : null;
		if (!after?.uri || after.kind !== media) return null;
		for (const e of Object.values(cs.edges)) {
			if (e.target !== nodeId) continue;
			const upAid = cs.nodes[e.source]?.data.resultAssetId;
			const up = upAid ? s.assets[upAid] : null;
			if (up?.uri && up.kind === media) {
				return {
					media,
					beforeUri: up.uri,
					afterUri: after.uri,
					afterName: after.name,
					beforeLabel: media === "image" ? "原图" : "原视频",
					afterLabel: purpose === "video.desub" ? "去字幕" : "超分",
				};
			}
		}
		return null;
	});
	if (!node) return null;
	const params = node.data.params || {};
	const purpose = typeof params.purpose === "string" ? params.purpose : "";
	const title = PROC_TITLES[purpose] || String(params.procLabel || "处理结果");
	const rerunnable = !!PROC_TITLES[purpose]; // resultOnly（本地产物）不可重跑
	const running = runtime?.status === "running" || runtime?.status === "queued";

	const catModel = rerunnable ? (catModels ?? []).find((m) => m.id === params.model) : undefined;
	const boxes = Array.isArray(params.erase_ratio_location) ? (params.erase_ratio_location as unknown[]).length : 0;
	const rows: { k: string; v: string }[] = [
		...(rerunnable ? [{ k: "处理方式", v: catModel?.label || String(params.model || "—") }] : []),
		...(catModel?.params ?? [])
			.filter((f) => params[f.key] !== undefined)
			.map((f) => ({ k: f.label, v: `${optLabel(f.key, String(params[f.key]))}${f.unit ? ` ${f.unit}` : ""}` })),
		...(purpose === "image.upscale" && params.multiple !== undefined
			? [{ k: "超分倍率", v: `×${params.multiple}（单边≤6000）` }]
			: []),
		...(purpose === "video.desub"
			? [{ k: "擦除范围", v: boxes > 0 ? `局部（${boxes} 个区域）` : "全屏（自动检测）" }]
			: []),
		...(params.procInfo ? [{ k: rerunnable ? "说明" : "区间", v: String(params.procInfo) }] : []),
	];

	const zoom = viewport.zoom;
	const nodeCenterX = node.x * zoom + viewport.x + (node.w / 2) * zoom;
	const nodeBottomY = (node.y + node.h) * zoom + viewport.y;
	const wrapperStyle: CSSProperties = {
		position: "absolute",
		left: `${nodeCenterX}px`,
		top: `${nodeBottomY + 8}px`,
		transform: "translate(-50%, 0) scale(0.9)",
		transformOrigin: "top center",
		zIndex: 10001,
	};

	return (
		<div
			style={wrapperStyle}
			data-node-panel
			className="pointer-events-auto flex flex-col items-center gap-2 w-fit"
			onClick={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.stopPropagation()}
			onPointerDown={(e) => e.stopPropagation()}
		>
			<motion.div
				initial={{ y: 10, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				exit={{ y: 10, opacity: 0 }}
				transition={{ duration: 0.18 }}
				style={{
					background: "rgba(22, 27, 38, 0.98)",
					border: "1px solid rgba(255, 255, 255, 0.1)",
					backdropFilter: "blur(20px)",
					boxShadow: "0 16px 48px rgba(0, 0, 0, 0.6)",
				}}
				className="w-[380px] rounded-2xl text-foreground flex flex-col overflow-hidden"
			>
				<div className="flex items-center gap-2 px-5 pt-4 pb-2">
					<Sparkles className="h-3.5 w-3.5 text-purple-300 shrink-0" />
					<span className="text-sm font-semibold">{title}</span>
					<span className="ml-auto text-[10px] text-muted-foreground">结果承载节点 · 只读</span>
				</div>
				<div className="flex flex-col gap-1.5 px-5 pb-3">
					{rows.map((r) => (
						<div key={r.k} className="flex items-center text-xs">
							<span className="w-20 shrink-0 text-muted-foreground">{r.k}</span>
							<span className="text-foreground/90 truncate" title={r.v}>{r.v}</span>
						</div>
					))}
				</div>
				<div className="flex items-center justify-between gap-3 px-5 py-2.5 border-t border-white/5">
					<span className="text-[10px] text-muted-foreground leading-relaxed">
						{rerunnable ? "源素材来自上游连线；「重新处理」按上方参数重跑（重新扣费）" : "本地截取产物；如需调整请在源节点重新分段"}
					</span>
					<div className="flex items-center gap-2 shrink-0">
						{compare && (
							<button
								onClick={() => setCompareOpen(true)}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/8 border border-white/10 text-foreground cursor-pointer whitespace-nowrap hover:bg-white/12 transition-colors"
								title={`全屏滑杆分割对比：左=${compare.beforeLabel}（上游），右=${compare.afterLabel}结果${compare.media === "video" ? "；双路同步播放" : ""}`}
							>
								<Columns2 className="h-3 w-3" />
								{compare.media === "image" ? "对比原图" : "对比原视频"}
							</button>
						)}
						{rerunnable && (
							<button
								onClick={() => dispatchCommand({ type: "run", nodeId })}
								disabled={running}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/8 border border-white/10 text-foreground cursor-pointer whitespace-nowrap hover:bg-white/12 transition-colors disabled:opacity-50 disabled:cursor-wait"
							>
								<Play className="h-3 w-3" />
								{running ? "处理中…" : "重新处理"}
							</button>
						)}
					</div>
				</div>
			</motion.div>

			{/* 对比弹窗（全屏）：portal 到 body（§9 规则：fixed 弹层不进 transform 容器） */}
			{compareOpen && compare &&
				createPortal(
					<MediaCompareModal
						media={compare.media}
						beforeUri={displayUriOf(compare.beforeUri)}
						afterUri={displayUriOf(compare.afterUri)}
						beforeLabel={compare.beforeLabel}
						afterLabel={compare.afterLabel}
						title={`${compare.afterLabel}对比 · ${(compare.afterName || "").replace(/\.[^.]+$/, "") || "素材"}`}
						onClose={() => setCompareOpen(false)}
					/>,
					document.body,
				)}
		</div>
	);
}
