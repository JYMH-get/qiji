/**
 * NodePromptEditor —— 画布节点提示词的富文本编辑器（与资产模式/放大弹窗一致）。
 * @ImageN/@VideoN/@AudioN 渲染成缩略图胶囊；输入 @ 弹待选框选素材。
 * 底层值仍是 @ImageN 规范文本（发上游/保存不变）；@[port] 上游引用作为纯文本保留（执行时仍解析）。
 * 预设方案的「插入」按钮已移到面板底部功能栏；本组件经 ref 暴露 insertPreset 供其调用。
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import PromptMentionEditor, { type PromptMentionHandle } from "@/components/PromptMentionEditor";
import { getNodeMaterialItems, importAssetToNode, upstreamTextSources } from "@/canvas/nodeMaterials";
import { addNodeMaterialFiles } from "@/canvas/nodeMaterials";
import { AssetImportDropdown } from "@/components/AssetImportDropdown";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { listPresetSchemes } from "@/lib/presetSchemes";
import { mapUpstreamText } from "@/lib/upstreamText";
import type { ShotMaterial } from "@/services/projectFile";

export interface NodePromptEditorHandle {
	/** 在提示词光标处插入一枚预设胶囊（供功能栏「预设方案」按钮调用） */
	insertPreset: (id: string, name: string) => void;
}

export const NodePromptEditor = forwardRef<NodePromptEditorHandle, {
	nodeId: string;
	prompt: string;
	onChange: (v: string) => void;
	placeholder?: string;
	style?: React.CSSProperties;
	/** 内容自适应高度的上下限（超过 maxHeight 内部滚动，避免面板被撑到无限高）*/
	minHeight?: number;
	maxHeight?: number;
}>(function NodePromptEditor({ nodeId, prompt, onChange, placeholder, style, minHeight = 96, maxHeight = 300 }, ref) {
	const editorRef = useRef<PromptMentionHandle>(null);
	const [mentionPos, setMentionPos] = useState<{ x: number; y: number } | null>(null);
	const [importPos, setImportPos] = useState<{ x: number; y: number } | null>(null);

	// 功能栏「预设方案」按钮经此把预设胶囊插到光标处（编辑器 ref 在本组件内）
	useImperativeHandle(ref, () => ({
		insertPreset: (id: string, name: string) => editorRef.current?.insertPreset(id, name),
	}), []);

	// 上游文本直映射：签名包含全文，确保同长改字也会刷新编辑器。
	const upstreamTextSig = useCanvasStore((s) =>
		Object.values(s.edges)
			.filter((e) => e.target === nodeId)
			.map((e) => {
				const up = s.nodes[e.source];
				const t = (typeof up?.data.resultText === "string" && up.data.resultText)
					|| (typeof up?.data.params.prompt === "string" ? up.data.params.prompt : "");
				return `${e.source}:${String(t)}`;
			})
			.sort()
			.join("|"),
	);
	const displayedPrompt = useMemo(
		() => mapUpstreamText(prompt, upstreamTextSources(nodeId).map((source) => source.text)),
		[nodeId, prompt, upstreamTextSig],
	);

	// 出图预设方案（随 catalog 版本 + 自定义预设变化刷新）——仅供 PromptMentionEditor 把 【预设:id】 渲染成 pill；插入按钮在功能栏
	const catalogVer = useCatalogStore((s) => s.catalog?.version);
	const customPresets = useSettingsStore((s) => s.customPresets);
	const presetOptions = useMemo(() => listPresetSchemes().map((p) => ({ id: p.id, name: p.name })), [catalogVer, customPresets]);

	// 上游素材响应性：候选列表含「上游连线素材」，但本组件此前不订阅连线/上游结果——
	// 连上上游或上游生成完时不重渲染，@ 弹出的还是旧候选（面板里无法 @ 上游素材的根因；
	// 放大弹窗的 getMentions 是打开时才调用所以没这个问题）。
	// 订阅一个轻量签名：本节点入边的 上游id:上游结果资产id 串，变化才重渲染。
	useCanvasStore((s) =>
		Object.values(s.edges)
			.filter((e) => e.target === nodeId)
			.map((e) => `${e.source}:${s.nodes[e.source]?.data.resultAssetId ?? ""}`)
			.sort()
			.join("|"),
	);
	// 上游素材的显示 uri/名称来自资产库（生成完成/本地副本落地时变化）
	useLibraryStore((s) => s.assets);

	const cands = getNodeMaterialItems(nodeId);
	const mkey = cands.map((c) => `${c.tag}|${c.uri}|${c.name}|${c.media}`).join(";");
	const materials = useMemo<ShotMaterial[]>(
		() => cands.map((c) => ({ id: c.tag, media: c.media, name: c.name || "", uri: c.uri, kind: "local" } as ShotMaterial)),
		[mkey], // eslint-disable-line react-hooks/exhaustive-deps
	);

	// @ 候选框开着时：数字键 1-9 快速选中对应候选（capture 拦截，防数字字符落进编辑器）
	useEffect(() => {
		if (!mentionPos) return;
		const onKey = (e: KeyboardEvent) => {
			const n = Number(e.key);
			if (!Number.isInteger(n) || n < 1 || n > Math.min(9, cands.length)) return;
			e.preventDefault();
			e.stopPropagation();
			editorRef.current?.insertMaterial(cands[n - 1].tag, true);
			setMentionPos(null);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mentionPos, mkey]);

	const ddLeft = mentionPos ? Math.min(mentionPos.x, window.innerWidth - 272) : 0;
	const ddTop = mentionPos ? Math.min(mentionPos.y + 18, window.innerHeight - 260) : 0;

	return (
		<div style={{ position: "relative", minWidth: 0, ...style }}>
			<PromptMentionEditor
				ref={editorRef}
				value={displayedPrompt}
				materials={materials}
				presets={presetOptions}
				onChange={onChange}
				onMentionProbe={(pos) => setMentionPos(pos)}
				onImportProbe={(pos) => setImportPos(pos)}
				onPasteMedia={(files) => void addNodeMaterialFiles(nodeId, files)}
				placeholder={placeholder}
				className="Qiji-scroll-thin nodrag"
				style={{ minHeight, maxHeight, width: "100%", minWidth: 0, padding: 8, fontSize: 12, lineHeight: 1.5, color: "#e6e6e6", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, overflowY: "auto" }}
			/>
			{/* @ 候选框必须 portal 到 body：操作面板容器带 transform(scale/translate)，
			    transform 祖先会劫持 position:fixed 的定位基准——不 portal 的话候选框按视口坐标
			    被画进面板坐标系，直接跑到屏幕外（"输入 @ 没有候选区"的根因；# 的下拉本就 portal 所以正常）。 */}
			{mentionPos && cands.length > 0 && createPortal(
				<div
					className="Qiji-scroll-thin nodrag"
					style={{ position: "fixed", left: ddLeft, top: ddTop, width: 240, maxHeight: 240, overflowY: "auto", background: "rgba(28,33,45,0.99)", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.6)", zIndex: 100002, padding: 4 }}
					onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
				>
					{cands.map((c, i) => (
						<div
							key={c.tag + i}
							onClick={() => { editorRef.current?.insertMaterial(c.tag, true); setMentionPos(null); }}
							style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", borderRadius: 6, cursor: "pointer" }}
							onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
							onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
						>
							<div style={{ width: 30, height: 30, borderRadius: 5, overflow: "hidden", flexShrink: 0, background: "rgba(255,255,255,0.06)", display: "flex", alignItems: "center", justifyContent: "center" }}>
								{c.media === "audio" ? <span style={{ fontSize: 14 }}>🎵</span>
									: c.media === "video" ? <video src={c.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} muted preload="metadata" />
										: c.uri ? <img src={c.uri} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
							</div>
							<div style={{ minWidth: 0, flex: 1 }}>
								<div style={{ fontSize: 12, color: "#c4b5fd", fontWeight: 600 }}>{c.tag}</div>
								{c.name && <div style={{ fontSize: 10, color: "rgba(255,255,255,0.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</div>}
							</div>
							{i < 9 && <span style={{ flexShrink: 0, fontSize: 10, color: "rgba(255,255,255,0.4)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 4, padding: "0 4px", lineHeight: "14px" }}>{i + 1}</span>}
						</div>
					))}
				</div>,
				document.body,
			)}
			{importPos && (
				<AssetImportDropdown
					pos={importPos}
					onClose={() => setImportPos(null)}
					onPick={(cand) => { const r = importAssetToNode(nodeId, cand); if (r) editorRef.current?.insertMaterial(r.tag, true, r.mat); setImportPos(null); }}
				/>
			)}
		</div>
	);
});
