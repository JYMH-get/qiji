/**
 * useCanvasPaste —— 画布 Ctrl+V 原生 paste 事件统一分流（第113轮）。
 *
 * 分流规则（优先级从上到下）：
 *  1. 内部节点粘贴：系统剪贴板文本 == NODE_COPY_MARKER（节点复制时写入的标记）、
 *     或系统剪贴板为空、或「复制节点后从未离开过本窗口」（标记写失败时的兜底判据——
 *     没离开过窗口就不可能从外部复制新内容）→ 克隆粘贴内部剪贴板节点（原语义）。
 *  2. 媒体文件（截图位图/资源管理器复制的图/视频/音频）→ importFilesToCanvas（与拖入同链路，
 *     上传 OSS + 上传节点承载；资产助手 <assetId>.<ext> 命中直接复用 id 建图片节点）。
 *  3. 纯文字 → 文本节点（text.seed，内容既是展示也是下游输入）。
 *
 * 落点：跟随最近一次鼠标位置（在画布内粘贴到指针处），无记录回退视口中心。
 * 输入框/弹窗内的粘贴一律让位原生行为（isEditingTarget / topLayerOpen 守卫）。
 */
import { useEffect, useRef } from "react";
import { useReactFlow, useStoreApi } from "@xyflow/react";
import { mediaFilesFromClipboard } from "@/lib/clipboardMedia";
import { hasClipboardData, lastCopiedAt } from "@/lib/clipboard";
import { pasteRoute } from "@/lib/pasteRoute";
import { pasteInternalNodes } from "@/canvas/pasteInternal";
import { importFilesToCanvas, createTextNodeAt } from "@/canvas/canvasFileImport";
import { isEditingTarget, topLayerOpen } from "./useCanvasKeyboard";

export function useCanvasPaste(): void {
	const { screenToFlowPosition } = useReactFlow();
	const rfStore = useStoreApi();
	const mouse = useRef<{ x: number; y: number } | null>(null);
	const blurAt = useRef(0);

	useEffect(() => {
		const onMove = (e: MouseEvent) => {
			mouse.current = { x: e.clientX, y: e.clientY };
		};
		const onBlur = () => {
			blurAt.current = Date.now();
		};
		const onPaste = (e: ClipboardEvent) => {
			if (isEditingTarget() || topLayerOpen()) return; // 输入框/弹窗内：原生粘贴
			const dt = e.clipboardData;
			const text = dt?.getData("text/plain") ?? "";
			const files = mediaFilesFromClipboard({ clipboardData: dt ?? null });
			const route = pasteRoute({
				text,
				fileCount: files.length,
				hasInternalNodes: hasClipboardData(),
				copiedAt: lastCopiedAt(),
				blurAt: blurAt.current,
			});
			if (route === "none") return;
			e.preventDefault();
			const p = mouse.current ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
			if (route === "internal") {
				const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
				pasteInternalNodes(center, () => rfStore.getState().unselectNodesAndEdges());
			} else if (route === "files") {
				importFilesToCanvas(files, screenToFlowPosition(p));
			} else {
				createTextNodeAt(text, screenToFlowPosition(p));
			}
		};
		window.addEventListener("mousemove", onMove, { passive: true });
		window.addEventListener("blur", onBlur);
		document.addEventListener("paste", onPaste);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("blur", onBlur);
			document.removeEventListener("paste", onPaste);
		};
	}, [screenToFlowPosition, rfStore]);
}
