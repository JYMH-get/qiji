/**
 * NodeProcessModals —— 节点媒体处理弹窗的全局挂载点（Canvas 内渲染一次）。
 * 入口：视频节点悬停工具栏 / 节点右键菜单 → uiStore.setNodeProcModal({nodeId, kind})。
 *  - upscale / desub / imageUpscale → VideoProcessModal（确认后 nodeProcess 生成新节点并运行）；
 *  - clip → ClipPickerModal（确认后 ffmpeg 裁剪 → 只读结果节点承载）。
 */
import { useState } from "react";
import { useUiStore } from "@/store/uiStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import VideoProcessModal from "@/components/VideoProcessModal";
import ClipPickerModal from "@/components/ClipPickerModal";
import GridSplitModal from "@/components/GridSplitModal";
import ScriptSplitModal from "@/components/ScriptSplitModal";
import AssetBindModal from "@/components/AssetBindModal";
import { processVideoNodeTo, processImageNodeTo, clipVideoNodeTo } from "@/canvas/nodeProcess";
import { splitImageToShotGroup } from "@/canvas/shotGroupOps";

export function NodeProcessModals() {
	const modal = useUiStore((s) => s.nodeProcModal);
	const close = () => useUiStore.getState().setNodeProcModal(null);
	const [busy, setBusy] = useState("");

	const assetUri = useLibraryStore((s) => {
		const aid = modal ? useCanvasStore.getState().nodes[modal.nodeId]?.data.resultAssetId : null;
		return aid ? s.assets[aid]?.uri ?? "" : "";
	});
	const assetName = useLibraryStore((s) => {
		const aid = modal ? useCanvasStore.getState().nodes[modal.nodeId]?.data.resultAssetId : null;
		return aid ? (s.assets[aid]?.name ?? "").replace(/\.[^.]+$/, "") : "";
	});
	// 原文拆分：取节点文本（结果文本优先，回退提示词）
	const scriptText = useCanvasStore((s) => {
		const n = modal && modal.kind === "scriptSplit" ? s.nodes[modal.nodeId] : null;
		if (!n) return "";
		const rt = typeof n.data.resultText === "string" ? n.data.resultText : "";
		const pr = typeof n.data.params.prompt === "string" ? n.data.params.prompt : "";
		return (rt.trim() ? rt : pr) || "";
	});

	if (!modal && !busy) return null;

	return (
		<>
			{modal && modal.kind === "clip" && (
				<ClipPickerModal
					uri={assetUri}
					title="选择视频片段（分段）"
					confirmText="提取为新节点"
					hint="由内置 ffmpeg 裁剪为 mp4；结果由只读节点承载（不可再运行）。"
					onCancel={close}
					onConfirm={(s, e) => {
						const nodeId = modal.nodeId;
						close();
						setBusy("裁剪视频中…");
						void clipVideoNodeTo(nodeId, s, e)
							.then(() => setBusy(""))
							.catch((err) => {
								setBusy("");
								alert(`分段失败：${err instanceof Error ? err.message : "未知错误"}`);
							});
					}}
				/>
			)}
			{modal && modal.kind === "gridSplit" && (
				<GridSplitModal
					uri={assetUri}
					sourceName={assetName || undefined}
					onCancel={close}
					onConfirm={(rows, cols, cells, trimBorder) => {
						const nodeId = modal.nodeId;
						close();
						setBusy(`宫格切分中…（${cells.length} 格）`);
						void splitImageToShotGroup(nodeId, rows, cols, cells, trimBorder)
							.then(() => setBusy(""))
							.catch((err) => {
								setBusy("");
								alert(`宫格切分失败：${err instanceof Error ? err.message : "未知错误"}`);
							});
					}}
				/>
			)}
			{modal && modal.kind === "scriptSplit" && (
				<ScriptSplitModal
					text={scriptText}
					onCancel={close}
					onConfirm={(segments) => {
						const nodeId = modal.nodeId;
						close();
						void import("@/canvas/scriptSplitOp").then(({ applyScriptSplit }) => {
							const n = applyScriptSplit(nodeId, segments);
							if (!n) alert("拆分失败：没有可拆分的原文内容。");
						});
					}}
				/>
			)}
			{modal && (modal.kind === "bindAsset" || modal.kind === "bindVoice") && (
				<AssetBindModal nodeId={modal.nodeId} mode={modal.kind === "bindAsset" ? "image" : "voice"} onCancel={close} />
			)}
			{modal && modal.kind !== "clip" && modal.kind !== "gridSplit" && modal.kind !== "scriptSplit" && modal.kind !== "bindAsset" && modal.kind !== "bindVoice" && (
				<VideoProcessModal
					uri={assetUri}
					mode={modal.kind}
					sourceName={assetName || undefined}
					onCancel={close}
					onConfirm={(spec) => {
						const { nodeId, kind } = modal;
						close();
						if (kind === "imageUpscale") processImageNodeTo(nodeId, spec);
						else if (kind === "upscale" || kind === "desub") processVideoNodeTo(nodeId, kind, spec);
					}}
				/>
			)}
			{busy && (
				<div style={{ position: "fixed", inset: 0, zIndex: 10600, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.45)" }}>
					<div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 22px", borderRadius: 10, background: "#161b26", border: "1px solid rgba(255,255,255,0.12)", color: "#fff", fontSize: 13 }}>
						<span className="inline-block animate-spin">↻</span>{busy}
					</div>
				</div>
			)}
		</>
	);
}
