
import { ImageOff, RefreshCw, ScrollText } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { dispatchCommand } from "@/command/dispatch";
import type { ResultKind } from "@/types";

/**
 * 节点对外只展示结果（图片/视频/文本/脚本/音频）。
 * 四态状态机：idle / loading(queued+running) / success / error，
 * 每种状态有明确的视觉反馈。
 */
export function ResultView({
	nodeId,
	kind,
	onResolutionChange,
}: {
	nodeId: string;
	kind: ResultKind;
	onResolutionChange?: (resStr: string, w: number, h: number) => void;
}) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const assetId = node?.data.resultAssetId ?? null;
	const asset = useLibraryStore((s) =>
		assetId ? (s.assets[assetId] ?? null) : null,
	);
	const params = node?.data.params ?? {};
	const status = useCanvasStore((s) => s.runtime[nodeId]?.status ?? "idle");
	const progress = useCanvasStore((s) => s.runtime[nodeId]?.progress ?? 0);
	const errorMsg = useCanvasStore((s) => s.runtime[nodeId]?.error ?? null);

	const isLoading = status === "queued" || status === "running" || status === "scheduled";
	const isFailed = status === "failed";

	// Loading 态：旋转动画 + 进度文字
	if (isLoading) {
		return (
			<div className="Qiji-result flex flex-col items-center justify-center gap-2.5">
				<div className="Qiji-spinner" />
				<span className="text-[10px] text-muted-foreground tracking-widest font-medium select-none">
					{status === "queued" ? "排队中…" : status === "scheduled" ? "已排期" : `生成中 ${progress}%`}
				</span>
			</div>
		);
	}

	// Error 态：错误信息 + 重试按钮
	if (isFailed) {
		return (
			<div className="Qiji-result flex flex-col items-center justify-center gap-2.5 px-4">
				<div className="text-[11px] text-red-400/90 text-center leading-snug line-clamp-2 max-w-[220px]">
					{errorMsg || "生成失败"}
				</div>
				<button
					type="button"
					className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-medium text-foreground/80 transition hover:scale-[1.03] hover:bg-white/10 hover:text-foreground cursor-pointer select-none"
					onClick={(e) => {
						e.stopPropagation();
						dispatchCommand({ type: "run", nodeId });
					}}
				>
					<RefreshCw className="size-3" />
					重试
				</button>
			</div>
		);
	}

	// 针对文档素材节点 (file_document)，展示文档预览样式
	if (node?.type === "file_document") {
		return (
			<div className="Qiji-result Qiji-result--filled flex flex-col items-center justify-center p-2 text-center w-full h-full">
				<ScrollText className="h-7 w-7 mb-1 text-sky-400" />
				<span className="text-[10px] text-foreground font-medium truncate max-w-full px-1.5" title={asset?.name}>
					{asset?.name || "未命名文档"}
				</span>
				<span className="text-[9px] text-muted-foreground mt-0.5 select-none">
					已载入文档
				</span>
			</div>
		);
	}

	// 文本 / 脚本：展示生成结果（优先 asset 内容，回退到 prompt 占位）
	if (kind === "text" || kind === "script") {
		const text =
			asset?.kind === "script" && asset.uri
				? asset.name // 显示资产名作为占位（完整内容需异步加载）
				: typeof params.prompt === "string" && params.prompt.trim()
					? (params.prompt as string)
					: "";
		return (
			<div className={"Qiji-result " + (text ? "Qiji-result--filled" : "")}>
				{text ? (
					<div className="Qiji-result__text Qiji-scroll-thin text-[10px] leading-normal p-2.5">{text}</div>
				) : (
					<span className="text-[10px] opacity-65 select-none font-medium">未生成</span>
				)}
			</div>
		);
	}

	// 图片 / 视频 / 音频：实际渲染媒体内容
	const filled = Boolean(asset);

	return (
		<div className={"Qiji-result " + (filled ? "Qiji-result--filled" : "")}>
			{filled && asset ? (
				<>
					{kind === "image" && (
						<img
							src={asset.uri}
							alt={asset.name}
							className="Qiji-result__img"
							draggable={false}
							onLoad={(e) => {
								const img = e.currentTarget;
								if (onResolutionChange) {
									onResolutionChange(
										`${img.naturalWidth} × ${img.naturalHeight}`,
										img.naturalWidth,
										img.naturalHeight
									);
								}
							}}
						/>
					)}
					{kind === "video" && (
						<video
							src={asset.uri}
							className="Qiji-result__video"
							controls
							preload="metadata"
							onClick={(e) => e.stopPropagation()}
							onLoadedMetadata={(e) => {
								const video = e.currentTarget;
								if (onResolutionChange) {
									onResolutionChange(
										`${video.videoWidth} × ${video.videoHeight}`,
										video.videoWidth,
										video.videoHeight
									);
								}
							}}
						/>
					)}
					{kind === "audio" && (
						<div className="Qiji-result__audio-wrap w-full flex flex-col items-center justify-center p-2">
							<span className="text-[9px] text-muted-foreground mb-1.5 truncate max-w-full font-medium" title={asset.name}>
								{asset.name}
							</span>
							<audio
								src={asset.uri}
								controls
								className="w-full nodrag scale-90 origin-center"
								onClick={(e) => e.stopPropagation()}
							/>
						</div>
					)}
				</>
			) : (
				<span className="flex flex-col items-center gap-1 text-muted-foreground select-none text-[10px] opacity-65 font-medium">
					<ImageOff className="h-4.5 w-4.5 opacity-50" />
					<span>未生成</span>
				</span>
			)}
		</div>
	);
}
