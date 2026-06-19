/**
 * ImageEditPanel — 图像编辑面板
 *
 * 弹出式浮层，提供三种编辑操作：
 * 1. 裁剪：交互式裁剪框（可拖拽调整位置 + 四角缩放手柄）
 * 2. 旋转：滑块控制角度，实时预览
 * 3. 超分辨率：选择倍数（2x/4x），调用后端 API
 *
 * 编辑完成后将新图片写入资产库 + 赋值到节点 resultAssetId
 */
import { useState, useRef, useEffect, useCallback, type CSSProperties } from "react";
import { motion } from "motion/react";
import {
	Crop,
	RotateCw,
	Maximize2,
	X,
	Check,
	Loader2,
} from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { genId } from "@/lib/id";
import { cropImage, rotateImage, upscaleImage, type EditResult } from "@/services/imageEditService";
import { dispatchCommand } from "@/command/dispatch";

interface ImageEditPanelProps {
	nodeId: string;
	onClose: () => void;
}

type EditMode = "crop" | "rotate" | "upscale";

type CropDragMode = "move" | "nw" | "ne" | "sw" | "se" | null;

const MAX_PREVIEW_W = 560;
const MAX_PREVIEW_H = 360;

/**
 * 图像编辑面板浮层
 */
export function ImageEditPanel({ nodeId, onClose }: ImageEditPanelProps) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const assetId = node?.data.resultAssetId ?? null;
	const asset = useLibraryStore((s) =>
		assetId ? (s.assets[assetId] ?? null) : null,
	);

	const [mode, setMode] = useState<EditMode>("rotate");
	const [processing, setProcessing] = useState(false);
	const [rotateAngle, setRotateAngle] = useState(0);
	const [upscaleScale, setUpscaleScale] = useState<2 | 4>(2);

	// 裁剪框状态（像素坐标，相对于原图）
	const [cropRect, setCropRect] = useState({ x: 0, y: 0, width: 100, height: 100 });
	const previewRef = useRef<HTMLCanvasElement>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const [imgNatural, setImgNatural] = useState({ w: 0, h: 0 });
	// 预览缩放比例（原图 → 预览显示）
	const [previewScale, setPreviewScale] = useState(1);
	const [previewSize, setPreviewSize] = useState({ w: 0, h: 0 });

	// 裁剪拖拽状态
	const cropDragRef = useRef<{ mode: CropDragMode; startX: number; startY: number; startRect: typeof cropRect }>({
		mode: null, startX: 0, startY: 0, startRect: { x: 0, y: 0, width: 0, height: 0 },
	});
	const cropOverlayRef = useRef<SVGSVGElement>(null);

	// 加载图片到 canvas 做预览
	useEffect(() => {
		if (!asset?.uri) return;
		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => {
			imgRef.current = img;
			const nw = img.naturalWidth;
			const nh = img.naturalHeight;
			setImgNatural({ w: nw, h: nh });
			setCropRect({ x: 0, y: 0, width: nw, height: nh });

			// 计算预览缩放
			const scale = Math.min(MAX_PREVIEW_W / nw, MAX_PREVIEW_H / nh, 1);
			setPreviewScale(scale);
			setPreviewSize({ w: Math.round(nw * scale), h: Math.round(nh * scale) });

			drawPreview(img, cropRect, rotateAngle);
		};
		img.src = asset.uri;
	}, [asset?.uri]);

	const drawPreview = useCallback(
		(img: HTMLImageElement, crop: typeof cropRect, angle: number) => {
			const canvas = previewRef.current;
			if (!canvas || !img) return;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;

			const cw = crop.width;
			const ch = crop.height;
			const rad = (angle * Math.PI) / 180;
			const cos = Math.abs(Math.cos(rad));
			const sin = Math.abs(Math.sin(rad));
			const outW = Math.ceil(cw * cos + ch * sin);
			const outH = Math.ceil(cw * sin + ch * cos);

			canvas.width = outW;
			canvas.height = outH;
			ctx.clearRect(0, 0, outW, outH);
			ctx.save();
			ctx.translate(outW / 2, outH / 2);
			ctx.rotate(rad);
			ctx.drawImage(img, crop.x, crop.y, cw, ch, -cw / 2, -ch / 2, cw, ch);
			ctx.restore();
		},
		[],
	);

	useEffect(() => {
		if (imgRef.current && mode === "crop") {
			drawPreview(imgRef.current, cropRect, 0);
		}
		if (imgRef.current && mode === "rotate") {
			drawPreview(imgRef.current, { x: 0, y: 0, width: imgNatural.w, height: imgNatural.h }, rotateAngle);
		}
	}, [mode, cropRect, rotateAngle, imgNatural, drawPreview]);

	// 裁剪框拖拽：鼠标按下
	const onCropMouseDown = useCallback((e: React.MouseEvent, dragMode: CropDragMode) => {
		e.preventDefault();
		e.stopPropagation();
		cropDragRef.current = {
			mode: dragMode,
			startX: e.clientX,
			startY: e.clientY,
			startRect: { ...cropRect },
		};

		const onMouseMove = (ev: MouseEvent) => {
			const drag = cropDragRef.current;
			const dragMode = drag.mode;
			if (!dragMode) return;
			const ps = previewScale;
			const dx = (ev.clientX - drag.startX) / ps;
			const dy = (ev.clientY - drag.startY) / ps;
			const sr = drag.startRect;
			const MIN_SIZE = 20;

			setCropRect(() => {
				let { x, y, width, height } = sr;

				if (dragMode === "move") {
					x = sr.x + dx;
					y = sr.y + dy;
					// 约束不超出原图范围
					x = Math.max(0, Math.min(x, imgNatural.w - width));
					y = Math.max(0, Math.min(y, imgNatural.h - height));
				} else {
					// 角落缩放
					if (dragMode.includes("e")) {
						width = Math.max(MIN_SIZE, sr.width + dx);
						width = Math.min(width, imgNatural.w - x);
					}
					if (dragMode.includes("w")) {
						const newX = Math.max(0, sr.x + dx);
						width = sr.width + (sr.x - newX);
						width = Math.max(MIN_SIZE, width);
						x = newX;
					}
					if (dragMode.includes("s")) {
						height = Math.max(MIN_SIZE, sr.height + dy);
						height = Math.min(height, imgNatural.h - y);
					}
					if (dragMode.includes("n")) {
						const newY = Math.max(0, sr.y + dy);
						height = sr.height + (sr.y - newY);
						height = Math.max(MIN_SIZE, height);
						y = newY;
					}
				}

				return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
			});
		};

		const onMouseUp = () => {
			cropDragRef.current.mode = null;
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
		};

		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
	}, [cropRect, previewScale, imgNatural]);

	const handleApply = async () => {
		if (!asset?.uri) return;
		setProcessing(true);
		try {
			let result: EditResult;
			if (mode === "crop") {
				result = await cropImage(asset.uri, cropRect);
			} else if (mode === "rotate") {
				result = await rotateImage(asset.uri, rotateAngle);
			} else {
				result = await upscaleImage(asset.uri, upscaleScale);
			}

			const newAssetId = `asset-${genId("edit")}`;
			const filename = `${node?.type || "image"}_edited_${Date.now()}.png`;

			const isTauri = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
			let localPath: string | null = null;
			let fileUri = result.objectUrl;

			if (isTauri) {
				try {
					await useProjectStore.getState().ensureProjectPath();
					const savePath = useProjectStore.getState().savePath!;
					const folder = savePath.replace(/[/\\][^/\\]+$/, "");
					const { writeFile, exists, mkdir } = await import("@tauri-apps/plugin-fs");
					const { join } = await import("@tauri-apps/api/path");
					const { convertFileSrc } = await import("@tauri-apps/api/core");

					const assetsDir = await join(folder, "assets");
					if (!(await exists(assetsDir))) {
						await mkdir(assetsDir, { recursive: true });
					}

					const destPath = await join(assetsDir, `${newAssetId}.png`);
					const arrayBuffer = await result.blob.arrayBuffer();
					await writeFile(destPath, new Uint8Array(arrayBuffer));
					localPath = destPath;
					fileUri = convertFileSrc(destPath);
				} catch (err) {
					console.error("Failed to save edited image:", err);
				}
			}

			useLibraryStore.getState().addAsset({
				id: newAssetId,
				kind: "image",
				name: filename,
				uri: fileUri,
				thumbnailUri: null,
				createdAt: new Date().toISOString(),
				deletedByUser: false,
				localPath,
			});

			dispatchCommand({ type: "setNodeResultAsset", nodeId, assetId: newAssetId });
			useProjectStore.getState().scheduleAutoSave("history");

			onClose();
		} catch (err) {
			console.error("Image edit failed:", err);
		} finally {
			setProcessing(false);
		}
	};

	if (!asset || asset.kind !== "image") return null;

	const accentStyle = { "--node-accent": "var(--node-image)" } as CSSProperties;

	// 裁剪框在预览坐标系中的位置
	const cropSvgX = cropRect.x * previewScale;
	const cropSvgY = cropRect.y * previewScale;
	const cropSvgW = cropRect.width * previewScale;
	const cropSvgH = cropRect.height * previewScale;
	const handleSize = 8;

	return (
		<motion.div
			initial={{ y: 10, opacity: 0 }}
			animate={{ y: 0, opacity: 1 }}
			exit={{ y: 10, opacity: 0 }}
			transition={{ duration: 0.18 }}
			style={{
				...accentStyle,
				background: "rgba(30, 37, 56, 0.96)",
				border: "1px solid rgba(255, 255, 255, 0.14)",
				backdropFilter: "blur(18px)",
				boxShadow: "0 12px 40px rgba(0, 0, 0, 0.5)",
			}}
			className="rounded-2xl text-foreground flex flex-col overflow-hidden min-w-[480px] max-w-[680px]"
			onClick={(e) => e.stopPropagation()}
		>
			{/* 顶部工具栏 */}
			<div className="flex items-center justify-between px-4 py-2 border-b border-border/15">
				<div className="flex items-center gap-1">
					<button
						onClick={() => setMode("crop")}
						className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
							mode === "crop" ? "bg-white/15 text-white" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
						}`}
					>
						<Crop className="h-3.5 w-3.5" /> 裁剪
					</button>
					<button
						onClick={() => setMode("rotate")}
						className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
							mode === "rotate" ? "bg-white/15 text-white" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
						}`}
					>
						<RotateCw className="h-3.5 w-3.5" /> 旋转
					</button>
					<button
						onClick={() => setMode("upscale")}
						className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
							mode === "upscale" ? "bg-white/15 text-white" : "text-muted-foreground hover:text-foreground hover:bg-white/5"
						}`}
					>
						<Maximize2 className="h-3.5 w-3.5" /> 超分辨率
					</button>
				</div>
				<button onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-secondary cursor-pointer">
					<X className="h-4 w-4" />
				</button>
			</div>

			{/* 预览区 */}
			<div className="relative flex items-center justify-center p-4 min-h-[240px]">
				{processing ? (
					<div className="flex flex-col items-center gap-2">
						<Loader2 className="h-8 w-8 animate-spin text-[color:var(--node-accent)]" />
						<span className="text-xs text-muted-foreground">处理中...</span>
					</div>
				) : mode === "crop" && imgRef.current ? (
					/* 裁剪模式：图片 + SVG 叠加裁剪框 */
					<div className="relative inline-block select-none" style={{ width: previewSize.w, height: previewSize.h }}>
						<img
							src={asset.uri}
							crossOrigin="anonymous"
							className="rounded-lg border border-white/10"
							style={{ width: previewSize.w, height: previewSize.h, objectFit: "contain" }}
							draggable={false}
							alt="crop preview"
						/>
						<svg
							ref={cropOverlayRef}
							className="absolute inset-0"
							width={previewSize.w}
							height={previewSize.h}
							style={{ cursor: "default" }}
						>
							{/* 暗色遮罩（裁剪区域外部） */}
							<defs>
								<mask id="crop-mask">
									<rect width="100%" height="100%" fill="white" />
									<rect x={cropSvgX} y={cropSvgY} width={cropSvgW} height={cropSvgH} fill="black" />
								</mask>
							</defs>
							<rect width="100%" height="100%" fill="rgba(0,0,0,0.5)" mask="url(#crop-mask)" />

							{/* 裁剪框边框 */}
							<rect
								x={cropSvgX} y={cropSvgY} width={cropSvgW} height={cropSvgH}
								fill="none"
								stroke="rgba(255,255,255,0.8)"
								strokeWidth={1.5}
								strokeDasharray="4 2"
								cursor="move"
								onMouseDown={(e) => onCropMouseDown(e, "move")}
							/>

							{/* 九宫格辅助线 */}
							<line x1={cropSvgX + cropSvgW / 3} y1={cropSvgY} x2={cropSvgX + cropSvgW / 3} y2={cropSvgY + cropSvgH} stroke="rgba(255,255,255,0.25)" strokeWidth={0.5} />
							<line x1={cropSvgX + 2 * cropSvgW / 3} y1={cropSvgY} x2={cropSvgX + 2 * cropSvgW / 3} y2={cropSvgY + cropSvgH} stroke="rgba(255,255,255,0.25)" strokeWidth={0.5} />
							<line x1={cropSvgX} y1={cropSvgY + cropSvgH / 3} x2={cropSvgX + cropSvgW} y2={cropSvgY + cropSvgH / 3} stroke="rgba(255,255,255,0.25)" strokeWidth={0.5} />
							<line x1={cropSvgX} y1={cropSvgY + 2 * cropSvgH / 3} x2={cropSvgX + cropSvgW} y2={cropSvgY + 2 * cropSvgH / 3} stroke="rgba(255,255,255,0.25)" strokeWidth={0.5} />

							{/* 四角缩放手柄 */}
							{(["nw", "ne", "sw", "se"] as const).map((corner) => {
								const cx = corner.includes("w") ? cropSvgX : cropSvgX + cropSvgW;
								const cy = corner.includes("n") ? cropSvgY : cropSvgY + cropSvgH;
								const cursor =
									corner === "nw" ? "nwse-resize" :
									corner === "ne" ? "nesw-resize" :
									corner === "sw" ? "nesw-resize" :
									"nwse-resize";
								return (
									<rect
										key={corner}
										x={cx - handleSize / 2}
										y={cy - handleSize / 2}
										width={handleSize}
										height={handleSize}
										fill="white"
										stroke="rgba(0,0,0,0.4)"
										strokeWidth={1}
										rx={2}
										cursor={cursor}
										onMouseDown={(e) => onCropMouseDown(e, corner)}
									/>
								);
							})}
						</svg>
					</div>
				) : (
					<canvas
						ref={previewRef}
						className="max-w-full max-h-[300px] rounded-lg border border-white/10"
						style={{ objectFit: "contain" }}
					/>
				)}
			</div>

			{/* 参数控制区 */}
			<div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border/15">
				{mode === "crop" && (
					<div className="flex items-center gap-3 text-xs text-muted-foreground">
						<span>X: {Math.round(cropRect.x)}</span>
						<span>Y: {Math.round(cropRect.y)}</span>
						<span>W: {Math.round(cropRect.width)}</span>
						<span>H: {Math.round(cropRect.height)}</span>
						<span className="text-[9px] opacity-60">(拖拽裁剪框调整区域)</span>
					</div>
				)}
				{mode === "rotate" && (
					<div className="flex items-center gap-3 flex-1">
						<input
							type="range"
							min={-180}
							max={180}
							step={1}
							value={rotateAngle}
							onChange={(e) => setRotateAngle(Number(e.target.value))}
							className="flex-1 h-1.5 bg-secondary/45 rounded-lg appearance-none cursor-pointer accent-[color:var(--node-accent)]"
						/>
						<span className="text-xs font-mono text-foreground min-w-[40px] text-right">{rotateAngle}°</span>
					</div>
				)}
				{mode === "upscale" && (
					<div className="flex items-center gap-2">
						<button
							onClick={() => setUpscaleScale(2)}
							className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
								upscaleScale === 2 ? "bg-[color:var(--node-accent)] text-white" : "bg-white/8 text-muted-foreground hover:bg-white/12"
							}`}
						>
							2x
						</button>
						<button
							onClick={() => setUpscaleScale(4)}
							className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
								upscaleScale === 4 ? "bg-[color:var(--node-accent)] text-white" : "bg-white/8 text-muted-foreground hover:bg-white/12"
							}`}
						>
							4x
						</button>
						<span className="text-[9px] text-muted-foreground ml-2">(客户端插值，后续接入后端超分)</span>
					</div>
				)}

				<div className="flex items-center gap-2 shrink-0">
					<button
						onClick={onClose}
						className="px-3 py-1.5 rounded-lg text-xs text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
					>
						取消
					</button>
					<button
						onClick={handleApply}
						disabled={processing}
						className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium bg-[color:var(--node-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer"
					>
						<Check className="h-3.5 w-3.5" /> 应用
					</button>
				</div>
			</div>
		</motion.div>
	);
}