import { AccelerationMaterialStatus } from '@/components/AccelerationMaterialStatus';
import { useEffect, useRef, useState } from "react";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { openLightbox } from "@/store/lightboxStore";
import { TAG_BADGE, BADGE_BG } from "@/lib/shotMaterials";
import { mediaFilesFromDataTransfer } from "@/lib/clipboardMedia";
import { addNodeMaterialFiles, removeNodeMaterial, removeUpstreamMaterial, listNodeMaterials, cycleNodeMaterialPrompt, syncNodeLegend, type NodeMatEntry } from "@/canvas/nodeMaterials";
import { materialPromptState, MATERIAL_PROMPT_LABELS, nextMaterialPromptMode } from "@/lib/materialPrompt";
import type { PromptModalApi } from "@/store/promptModalStore";
import { usePendingUploads, uploadKeys } from "@/store/uploadStore";
import { useDisplayUri } from "@/nodes/ResultView";
import { IdentityAssetToggle } from "@/components/IdentityAssetToggle";
import { FolderOpen, MousePointer2, Upload, Repeat2 } from "lucide-react";
import { useUiStore } from "@/store/uiStore";

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
function MatTile({ it, doRemove, identity, modelId }: { modelId?: string; it: NodeMatEntry; doRemove: (() => void) | null; identity?: { active: boolean; toggle: () => void; modelId?: string } }) {
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
			<AccelerationMaterialStatus modelId={modelId} kind={it.media} material={{ id: it.id, url: it.url || it.uri, name: it.name }} />
			{identity && <IdentityAssetToggle kind={it.media} modelId={identity.modelId} material={{ id: it.id, url: it.url || it.uri, name: it.name }} active={identity.active} onToggle={identity.toggle} />}
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
export function NodeMaterialBay({
	nodeId,
	rightAction,
	identityModelId,
	identityEnabled = false,
	identityIndexes = [],
	onToggleIdentity,
	promptApi,
}: {
	nodeId: string;
	rightAction?: React.ReactNode;
	identityModelId?: string;
	identityEnabled?: boolean;
	identityIndexes?: number[];
	onToggleIdentity?: (imageIndex: number) => void;
	promptApi?: PromptModalApi;
}) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	// 订阅枚举的全部数据源（listNodeMaterials 读 getState()，这些订阅保证变更时重渲染）
	useCanvasStore((s) => s.edges);
	useCanvasStore((s) => s.nodes);
	useLibraryStore((s) => s.assets);
	useProjectStore((s) => s.assetBlobs);
	const fileRef = useRef<HTMLInputElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const uploading = usePendingUploads(uploadKeys.node(nodeId)); // 在途上传数 → 占位转圈
	const materialSignature = listNodeMaterials(nodeId).map(m => `${m.key}:${m.assetId}:${m.name}:${m.uri}`).join("|");
	useEffect(() => {
		if (useCanvasStore.getState().nodes[nodeId]?.data.params.materialPrompt) syncNodeLegend(nodeId);
	}, [nodeId, materialSignature]);
	useEffect(() => {
		if (!menuOpen) return;
		const close = (e: MouseEvent) => {
			if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
		};
		document.addEventListener("mousedown", close);
		return () => document.removeEventListener("mousedown", close);
	}, [menuOpen]);
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
				const imageIndex = it.media === "image" ? it.n - 1 : -1;
				const identity = identityEnabled
					? { modelId: identityModelId, active: imageIndex >= 0 ? identityIndexes.includes(imageIndex) : true, toggle: () => { if (imageIndex >= 0) onToggleIdentity?.(imageIndex); } }
					: undefined;
				return <MatTile modelId={identityModelId} key={it.key} it={it} doRemove={doRemove} identity={identity} />;
			})}
			{/* 在途上传占位：转圈，表示正在传 OSS */}
			{Array.from({ length: uploading }).map((_, i) => (
				<div key={`up-${i}`} title="上传中…" className="relative w-11 h-11 rounded-xl border border-dashed border-white/20 bg-white/5 shrink-0 flex items-center justify-center">
					<span className="sb-spin text-white/80 text-sm">↻</span>
				</div>
			))}
			{/* ＋ 三路添加：本地上传 / 资产库连续选择 / 画布多选 */}
			<div ref={menuRef} className="relative shrink-0">
				<button
					onClick={(e) => { e.stopPropagation(); setMenuOpen((v) => !v); }}
					title="添加参考素材"
					className="w-11 h-11 rounded-xl border border-dashed border-white/25 text-muted-foreground text-lg leading-none flex items-center justify-center hover:border-primary hover:text-foreground transition-colors"
				>+</button>
				{menuOpen && (
					<div className="absolute left-0 top-full z-[10450] mt-1 w-44 rounded-xl border border-white/10 bg-[#202020] p-1.5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
						<button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-white hover:bg-white/10" onClick={() => { setMenuOpen(false); fileRef.current?.click(); }}>
							<Upload className="h-4 w-4" />上传参考内容
						</button>
						<button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-white hover:bg-white/10" onClick={() => { setMenuOpen(false); useUiStore.getState().setAssetLibraryTargetNodeId(nodeId); }}>
							<FolderOpen className="h-4 w-4" />从资产库添加
						</button>
						<button className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] text-white hover:bg-white/10" onClick={() => {
							setMenuOpen(false);
							useUiStore.getState().setActiveNodeId(nodeId);
							useUiStore.getState().setCanvasMode({ type: "asset-pick", targetNodeId: nodeId, materialGroupId: null });
						}}>
							<MousePointer2 className="h-4 w-4" />从画布选择
						</button>
					</div>
				)}
			</div>
			<input
				ref={fileRef}
				type="file"
				accept="image/*,video/*,audio/*"
				multiple
				style={{ display: "none" }}
				onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) void addNodeMaterialFiles(nodeId, fs); e.target.value = ""; }}
			/>
			{/* 右侧操作槽（如提示词放大按钮）：推到本行最右 */}
			<div className="ml-auto flex items-center gap-2">
				<button type="button" aria-label="素材图例转换" title={`素材图例转换：${MATERIAL_PROMPT_LABELS[materialPromptState(node.data.params.materialPrompt)?.mode || "legend"]} → ${MATERIAL_PROMPT_LABELS[nextMaterialPromptMode(materialPromptState(node.data.params.materialPrompt)?.mode || "legend")]}`} className="nodrag" onClick={(e) => { e.stopPropagation(); const text = cycleNodeMaterialPrompt(nodeId, promptApi?.getValue?.()); promptApi?.setValue?.(text); }} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: 5, borderRadius: 6, color: "#c4b5fd", background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.3)", cursor: "pointer" }}>
					<Repeat2 size={19} /><span style={{ fontSize: 10 }}>{({ legend: 1, inline: 2, both: 3 })[materialPromptState(node.data.params.materialPrompt)?.mode || "legend"]}</span>
				</button>
				{rightAction}
			</div>
		</div>
	);
}
