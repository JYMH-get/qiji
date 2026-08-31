import { useRef } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { openLightbox } from "@/store/lightboxStore";
import { TAG_BADGE, BADGE_BG } from "@/lib/shotMaterials";
import { mediaFilesFromDataTransfer } from "@/lib/clipboardMedia";
import { addNodeMaterialFiles, removeNodeMaterial, removeUpstreamMaterial, listNodeMaterials, type NodeMatEntry } from "@/canvas/nodeMaterials";
import { usePendingUploads, uploadKeys } from "@/store/uploadStore";
import { useDisplayUri } from "@/nodes/ResultView";

/** 右键取消垫图是快捷操作：拦住浏览器/画布菜单后立即执行，不再追加确认步骤。 */
export function removeMaterialOnContextMenu(
	e: Pick<React.MouseEvent, "preventDefault" | "stopPropagation">,
	doRemove: () => void,
): void {
	e.preventDefault();
	e.stopPropagation();
	doRemove();
}

/**
 * 素材区单格：显示 uri 经 useDisplayUri 自愈解析（远程 https 在 Tauri 下被 CSP 拦、死 blob: 凭三元映射
 * 反查换源）——与 ResultView/素材库 LibTile 同一把尺，不再裸用 it.uri（裸用=垫图黑块「无法播放」观感）。
 * 双击放大也用解析后的 uri（灯箱同样要能播）。
 */
function MatTile({ it, doRemove }: { it: NodeMatEntry; doRemove: (() => void) | null }) {
	const uri = useDisplayUri(it.uri || it.url);
	return (
		<div
			className="relative w-11 h-11 rounded-xl border border-white/10 bg-white/5 overflow-hidden shrink-0 group cursor-zoom-in"
			title={`${TAG_BADGE[it.media]}${it.n}${it.name ? `·${it.name}` : ""}${it.self ? "（双击放大 / 右键删除）" : "（上游素材·双击放大 / 右键删除=断开连线）"}`}
			onDoubleClick={() => uri && openLightbox({ uri, media: it.media, name: it.name || "" })}
			onContextMenu={doRemove ? (e) => removeMaterialOnContextMenu(e, doRemove) : undefined}
		>
			{it.media === "video" ? (
				<video src={uri} className="w-full h-full object-cover" muted preload="metadata" />
			) : it.media === "audio" ? (
				<span className="flex h-full w-full items-center justify-center text-base">🎵</span>
			) : (
				<img src={uri} className="w-full h-full object-cover" draggable={false} />
			)}
			{/* 左上角 @tag 角标 */}
			<span className="absolute top-0 left-0 text-[8px] leading-3 px-[3px] rounded-br font-bold text-white" style={{ background: BADGE_BG[it.media] }}>{TAG_BADGE[it.media]}{it.n}</span>
			{/* 悬停删除：上游素材=断开连线 */}
			{doRemove && (
				<button
					onClick={(e) => { e.stopPropagation(); doRemove(); }}
					title={it.self ? "删除" : "删除（断开与上游节点的连线）"}
					className="absolute top-0 right-0 hidden group-hover:flex h-4 w-4 items-center justify-center text-[10px] leading-none text-white bg-black/60 rounded-bl"
				>✕</button>
			)}
		</div>
	);
}

/**
 * 节点「素材区」(可编辑)——替代只读的 NodeRefMaterials。
 * 显示：上游连线素材(删除=断开连线) + 自行添加素材，**按加入顺序**（listNodeMaterials 单点枚举，
 * 素材只往后加），左上角 @ImageN/@VideoN/@AudioN 角标与图例/提交编号恒一致。
 * 添加：＋打开本地文件资源管理器 / 把本地文件拖入 / 在提示词框粘贴(由面板转发)。
 * 显示走本地 uri(CSP 安全)，请求走公网 url(由 pluginRegistry 按同一枚举合并)。
 */
export function NodeMaterialBay({ nodeId, rightAction }: { nodeId: string; rightAction?: React.ReactNode }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	// 订阅枚举的全部数据源（listNodeMaterials 读 getState()，这些订阅保证变更时重渲染）
	useCanvasStore((s) => s.edges);
	useCanvasStore((s) => s.nodes);
	useLibraryStore((s) => s.assets);
	useProjectStore((s) => s.assetBlobs);
	const fileRef = useRef<HTMLInputElement>(null);
	const uploading = usePendingUploads(uploadKeys.node(nodeId)); // 在途上传数 → 占位转圈
	if (!node) return null;

	// 加入顺序 + 与图例/提交一致的编号；名字为友好名（绑定资产名/节点标题，非机器文件名）
	const items = listNodeMaterials(nodeId);

	const onDropFiles = (e: React.DragEvent) => {
		const files = mediaFilesFromDataTransfer(e.dataTransfer);
		if (files.length) { e.preventDefault(); e.stopPropagation(); void addNodeMaterialFiles(nodeId, files); }
	};

	return (
		<div className="flex flex-row flex-wrap gap-2 mb-3 shrink-0" data-node-material-bay={nodeId} onDragOver={(e) => e.preventDefault()} onDrop={onDropFiles}>
			{items.map((it) => {
				// 删除语义：自加素材=从 input 移除；上游素材=断开对应连线（提示词 @ 引用均自动重编号）
				const doRemove = it.self
					? () => removeNodeMaterial(nodeId, it.self!.group, it.self!.idx)
					: it.edgeId
						? () => removeUpstreamMaterial(nodeId, it.edgeId!)
						: null;
				return <MatTile key={it.key} it={it} doRemove={doRemove} />;
			})}
			{/* 在途上传占位：转圈，表示正在传 OSS */}
			{Array.from({ length: uploading }).map((_, i) => (
				<div key={`up-${i}`} title="上传中…" className="relative w-11 h-11 rounded-xl border border-dashed border-white/20 bg-white/5 shrink-0 flex items-center justify-center">
					<span className="sb-spin text-white/80 text-sm">↻</span>
				</div>
			))}
			{/* ＋ 打开本地文件资源管理器添加素材 */}
			<button
				onClick={() => fileRef.current?.click()}
				title="添加本地素材（图/视频/音频）——也可拖入文件或在提示词框粘贴"
				className="w-11 h-11 rounded-xl border border-dashed border-white/25 text-muted-foreground text-lg leading-none flex items-center justify-center hover:border-primary hover:text-foreground transition-colors"
			>+</button>
			<input
				ref={fileRef}
				type="file"
				accept="image/*,video/*,audio/*"
				multiple
				style={{ display: "none" }}
				onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) void addNodeMaterialFiles(nodeId, fs); e.target.value = ""; }}
			/>
			{/* 右侧操作槽（如提示词放大按钮）：推到本行最右 */}
			{rightAction && <div className="ml-auto flex items-center">{rightAction}</div>}
		</div>
	);
}
