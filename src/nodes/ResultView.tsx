
import { useRef, useState, useEffect, useMemo, type ReactNode, type ComponentType } from "react";
import { ImageOff, RefreshCw, ScrollText, AudioLines, Film, Globe, User, Image as ImageIco, Package, PawPrint, Users, Layers, LayoutGrid } from "lucide-react";
import { ShotGroupView } from "./ShotGroupView";
import { PanoNodeView } from "./PanoNodeView";
import { AudioWaveCard } from "./AudioWave";
import { parseAssetExtraction } from "@/lib/assetExtraction";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { useUiStore } from "@/store/uiStore";
import { openLightbox } from "@/store/lightboxStore";
import { dispatchCommand } from "@/command/dispatch";
import { saveRemoteAsset } from "@/services/assetPersist";
import { isWebviewLocalUri } from "@/lib/publicUrl";
import { progressLabel } from "@/lib/queueLabel";
import { getPlugin } from "./pluginRegistry";
import type { ResultKind } from "@/types";

const isTauriEnv = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
function hashUri(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return "disp" + (h >>> 0).toString(36);
}
/**
 * 节点媒体显示 uri 解析：远程 https 直链在 Tauri 下被 CSP(img/media-src) 拦→裂图。
 *  - 本地/内联 uri（asset:// / blob: / data:）直接用；
 *  - 远程 https：优先已登记的本地副本（blobByUri.localUri）；无则原生下载到本地 asset:// 再显示（自愈）。
 *  - 浏览器（非 Tauri）无 CSP 限制，https 直接用。
 */
export function useDisplayUri(uri?: string | null): string {
	const [resolved, setResolved] = useState(uri || "");
	useEffect(() => {
		if (!uri) { setResolved(""); return; }
		if (uri.startsWith("blob:")) {
			// blob: objectURL 是会话级：上一会话持久化下来的（如上传节点 data.fileUri）已死——能凭三元映射
			// 反查到别的源（localUri/公网 url）就换源；反查不到按原样用（本会话新建的 blob: 仍活）。
			const b = useProjectStore.getState().blobByUri(uri);
			if (b?.localUri && b.localUri !== uri) { setResolved(b.localUri); return; }
			if (!isTauriEnv() && b?.url) { setResolved(b.url); return; } // 浏览器无 CSP：公网直显
			setResolved(uri);
			return;
		}
		if (!/^https?:/i.test(uri)) { setResolved(uri); return; } // 本地/内联直接用
		// http://asset.localhost/... 形式上是 http 但**就是本地文件的显示态**：原样直用，绝不走
		// blob 映射/下载换源——跨项目复制残留的失效映射会把能播的直链换成死链（「短暂显示后裂开」根因）。
		if (isWebviewLocalUri(uri)) { setResolved(uri); return; }
		const blob = useProjectStore.getState().blobByUri(uri);
		if (blob?.localUri) { setResolved(blob.localUri); return; }
		if (!isTauriEnv()) { setResolved(uri); return; } // 浏览器无 CSP 限制
		setResolved(uri); // 先占位（Tauri 下会裂），随后被本地副本替换
		let alive = true;
		void (async () => {
			const b = await saveRemoteAsset(hashUri(uri), uri);
			if (alive && b?.localUri) {
				useProjectStore.getState().registerAssetBlob({ ...b, srcUri: uri });
				setResolved(b.localUri);
			}
		})();
		return () => { alive = false; };
	}, [uri]);
	return resolved;
}

/** LOD 阈值：zoom 低于此值时，文本/对话/视频/音频内容换成轻量占位块（图片保留作缩略地标）。 */
const LOD_ZOOM = 0.35;
/** 节点内文本预览上限：整篇剧本级长文塞进 DOM 没有视觉收益（节点内本就滚动裁剪），只留头部。 */
const TEXT_PREVIEW_MAX = 3000;

function previewText(t: string): string {
	if (t.length <= TEXT_PREVIEW_MAX) return t;
	return t.slice(0, TEXT_PREVIEW_MAX) + `\n……（共 ${t.length} 字，节点内仅预览前 ${TEXT_PREVIEW_MAX} 字，完整内容见操作面板）`;
}

/** 低缩放占位块：只有图标+一行字，替代重内容（大画布缩到全览时的渲染成本主力就砍在这） */
function LodBlock({ label, icon: Icon }: { label: string; icon?: ComponentType<{ className?: string }> }) {
	return (
		<div className="Qiji-result Qiji-result--filled flex items-center justify-center w-full h-full select-none">
			<span className="flex flex-col items-center gap-1 text-muted-foreground opacity-60">
				{Icon ? <Icon className="h-5 w-5" /> : null}
				<span className="text-[10px] font-medium truncate max-w-[180px]">{label}</span>
			</span>
		</div>
	);
}

/**
 * 资产拆分节点结果 = **资产模式剧本页同款统计面板**（角色/场景/物品/生物/群像/变体计数卡 + 项目视觉圣经），
 * 而非原始 JSON 文本。流式期间计数实时上涨；解析不出任何资产时回退为原始文本（便于排查格式）。
 */
function AssetSplitStats({ text, progress }: { text: string; progress?: number }) {
	const ex = useMemo(() => parseAssetExtraction(text), [text]);
	const variantCount = useMemo(
		() =>
			[ex.characters, ex.scenes, ex.items, ex.organisms, ex.crowds]
				.flat()
				.reduce((n, a) => n + (a.variants?.length || 0), 0),
		[ex],
	);
	const total = ex.characters.length + ex.scenes.length + ex.items.length + ex.organisms.length + ex.crowds.length;
	const vb = ex.visualBible;
	const hasVb = !!(vb.style || vb.colorSystem || vb.negativeGlobal);
	const streaming = progress !== undefined;

	// 解析不出任何东西：回退原始文本（流式尾部 / 全文预览）
	if (total === 0 && !hasVb) {
		const body = streaming && text.length > 1500 ? "…" + text.slice(-1500) : previewText(text);
		return (
			<div className="Qiji-result Qiji-result--filled relative">
				<div className="Qiji-result__text Qiji-scroll-thin text-[10px] leading-normal p-2.5 pb-5 whitespace-pre-wrap">{body}</div>
				{streaming && (
					<span className="absolute bottom-1 right-2 text-[9px] text-muted-foreground/80 select-none pointer-events-none">生成中 {progress}%…</span>
				)}
			</div>
		);
	}

	const cards: { label: string; count: number; color: string; icon: ComponentType<{ className?: string; style?: React.CSSProperties }> }[] = [
		{ label: "角色", count: ex.characters.length, color: "#a78bfa", icon: User },
		{ label: "场景", count: ex.scenes.length, color: "#60a5fa", icon: ImageIco },
		{ label: "物品", count: ex.items.length, color: "#facc15", icon: Package },
		{ label: "生物", count: ex.organisms.length, color: "#4ade80", icon: PawPrint },
		{ label: "群像", count: ex.crowds.length, color: "#f472b6", icon: Users },
		{ label: "变体", count: variantCount, color: "#22d3ee", icon: Layers },
	];
	const vbRows = [
		{ label: "全局风格", value: vb.style, color: "#a78bfa" },
		{ label: "全局色调", value: vb.colorSystem, color: "#facc15" },
		{ label: "全局反向提示词", value: vb.negativeGlobal, color: "#f87171" },
	];

	return (
		<div className="Qiji-result Qiji-result--filled relative w-full h-full">
			<div className="Qiji-scroll-thin flex flex-col gap-2 p-2 w-full h-full overflow-y-auto">
				{/* 统计卡（与剧本页「已分析」区同款：图标+计数+类别） */}
				<div className="grid grid-cols-3 gap-1.5 shrink-0">
					{cards.map((c) => (
						<div key={c.label} className="rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1.5 flex flex-col gap-0.5 min-w-0">
							<span className="flex items-center gap-1 text-[9px] text-muted-foreground select-none">
								<c.icon className="h-3 w-3" style={{ color: c.color }} />
								{c.label}
							</span>
							<span className="text-sm font-bold leading-none" style={{ color: c.count > 0 ? "#fff" : "rgba(255,255,255,0.35)" }}>
								{c.count}
							</span>
						</div>
					))}
				</div>
				{/* 项目视觉圣经（全局锚点·所有资产继承） */}
				{hasVb && (
					<div className="flex flex-col gap-1 shrink-0">
						<span className="text-[9px] font-semibold text-muted-foreground select-none">项目视觉圣经</span>
						{vbRows.filter((r) => r.value).map((r) => (
							<div key={r.label} className="rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 min-w-0">
								<span className="flex items-center gap-1 text-[8px] text-muted-foreground select-none">
									<span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: r.color }} />
									{r.label}
								</span>
								<div className="text-[9px] text-foreground/85 leading-snug line-clamp-2 break-all" title={r.value}>{r.value}</div>
							</div>
						))}
					</div>
				)}
				<div className="text-[8px] text-muted-foreground/70 select-none pb-3">
					{streaming ? "提取一个并入一个：资产已实时进入 角色/场景/物品/生物/群像 界面" : `共 ${total} 个资产（含 ${variantCount} 个变体）· 已入项目资产库`}
				</div>
			</div>
			{streaming && (
				<span className="absolute bottom-1 right-2 text-[9px] text-muted-foreground/80 select-none pointer-events-none">解析中 {progress}%…</span>
			)}
		</div>
	);
}

/**
 * 节点对外只展示结果（结果即显示）。
 * 按节点 spec 的 display 渲染：text / image / video / audio / chat / file。
 * 四态：idle / loading(queued+running) / success / error。
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
	// 第251轮排队提示：三个单值选择器（仅该值变化才重渲染，合 §9 画布渲染性能规则）
	const queuePosition = useCanvasStore((s) => s.runtime[nodeId]?.queuePosition);
	const queueTotal = useCanvasStore((s) => s.runtime[nodeId]?.queueTotal);
	const stageText = useCanvasStore((s) => s.runtime[nodeId]?.stageText);
	const edges = useCanvasStore((s) => s.edges);
	// 双快原则·预览本地（第146轮，勿回退）：显示按资产 id **现查三元映射的活本地副本**优先——
	// 库记录/节点里存的 uri 是写入时快照（可能是死 blob:/失效直链），映射由 上传/自愈/重传 随时升级，
	// 按 id 现查让升级立刻反映到所有显示处（id 是真理，uri 是缓存）。选择器返回单值，仅该值变化才重渲染。
	const liveLocalUri = useProjectStore((s) => {
		const sid = asset?.serverAssetId || asset?.id || "";
		return (sid && s.assetBlobs[sid]?.localUri) || null;
	});
	// 显示 uri：远程 https 解析为本地 asset:// 副本（避免 CSP 裂图）。须在任何 early return 前调用（hooks 顺序稳定）。
	const displayUri = useDisplayUri(liveLocalUri ?? asset?.uri ?? node?.data.fileUri ?? "");
	// LOD：布尔选择器只在跨过阈值时才触发一次重渲染（绝不能直接订阅 zoom 数值——那会让缩放逐帧全节点重渲染）
	const lod = useCanvasStore((s) => s.viewport.zoom < LOD_ZOOM);
	// 图片/视频节点：堆叠抽屉展开态（uiStore 全局单例——右键「打开堆叠」/快捷键 C/角标点击共用）
	const drawerOpen = useUiStore((s) => s.stackDrawerNodeId === nodeId);

	const plugin = node ? getPlugin(node.type) : undefined;
	const display = (plugin?.displayKind ?? kind) as string;

	const isLoading = status === "queued" || status === "running" || status === "scheduled" || status === "uploading";
	const isFailed = status === "failed";

	// 分镜组：宫格布局渲染（拖动排序/序号/工具条都在 ShotGroupView 内）
	if (display === "shotgroup") {
		if (lod) return <LodBlock label="分镜组" icon={LayoutGrid} />;
		return <ShotGroupView nodeId={nodeId} />;
	}

	// 720全景查看节点：节点内 WebGL 交互查看（拖动转视角/滚轮视场/双击全屏）
	if (display === "pano") {
		if (lod) return <LodBlock label="720°全景" icon={Globe} />;
		return <PanoNodeView nodeId={nodeId} />;
	}

	// AI对话（display=chat）：始终展示「用户提问 + 回答」两个文本框（流式时回答框内实时刷新）。
	// 置于通用 loading/error 之前，保证生成中两框不被转圈遮挡。
	if (display === "chat") {
		if (lod) return <LodBlock label="AI 对话" icon={ScrollText} />;
		const p = node?.data.params ?? {};
		const question = String(p.question ?? p.prompt ?? "");
		const answer = typeof node?.data.resultText === "string" ? node.data.resultText : "";
		const skipped = !!p.skipped;
		const boxCls =
			"Qiji-scroll-thin flex-1 min-h-[28px] rounded-md border border-[color:var(--node-chat)]/45 bg-white/[0.04] px-2 py-1 text-[10px] leading-snug whitespace-pre-wrap break-words overflow-y-auto";
		let answerView: ReactNode;
		if (isFailed) answerView = <span className="text-red-400/90">{errorMsg || "生成失败"}</span>;
		else if (answer) answerView = answer;
		else if (isLoading) answerView = <span className="opacity-55">回答中…</span>;
		else answerView = <span className="opacity-45">（待回答）</span>;
		return (
			<div className="Qiji-result Qiji-result--filled w-full h-full">
				<div className={`flex flex-col gap-1.5 p-2 w-full h-full ${skipped ? "opacity-45" : ""}`}>
					<div className="flex flex-col gap-0.5 min-h-0 flex-1">
						<span className="text-[9px] text-muted-foreground font-semibold shrink-0 select-none">
							用户提问{skipped ? "（已跳过本轮）" : ""}
						</span>
						<div className={`${boxCls} text-foreground/90`}>
							{question || <span className="opacity-45">（未填写提问）</span>}
						</div>
					</div>
					<div className="flex flex-col gap-0.5 min-h-0 flex-[1.4]">
						<span className="text-[9px] text-muted-foreground font-semibold shrink-0 select-none">回答</span>
						<div className={`${boxCls} text-foreground/90`}>{answerView}</div>
					</div>
				</div>
			</div>
		);
	}

	// 文本类节点流式期间：边收边显（旧逻辑被转圈整个盖住，流式数据到了也看不见）。
	// 显示尾部 1500 字（新字实时出现的观感），底部角标显示进度；无部分正文时仍走通用 loading。
	if (isLoading && (display === "text" || display === "script")) {
		const rt = typeof node?.data.resultText === "string" ? node.data.resultText : "";
		if (rt.trim()) {
			if (lod) return <LodBlock label={plugin?.label || "文本"} icon={ScrollText} />;
			// 资产拆分：流式期间即显示资产模式同款统计面板（计数实时上涨）
			if (node?.type === "asset.split") return <AssetSplitStats text={rt} progress={progress} />;
			const tail = rt.length > 1500 ? "…" + rt.slice(-1500) : rt;
			return (
				<div className="Qiji-result Qiji-result--filled relative">
					<div className="Qiji-result__text Qiji-scroll-thin text-[10px] leading-normal p-2.5 pb-5 whitespace-pre-wrap">{tail}</div>
					<span className="absolute bottom-1 right-2 text-[9px] text-muted-foreground/80 select-none pointer-events-none">
						生成中 {progress}%…
					</span>
				</div>
			);
		}
	}

	// Loading 态：条状脉冲 + 进度文字（运行即清场——旧结果已在运行前归档/清空，不压在运行态下面）
	if (isLoading) {
		return (
			<div className="Qiji-result flex flex-col items-center justify-center gap-2.5">
				<div className="Qiji-pulsebars" aria-hidden><span /><span /><span /><span /><span /></div>
				<span className="text-[10px] text-muted-foreground tracking-widest font-medium select-none">
					{status === "uploading"
					? "上传中…"
					: status === "scheduled"
						? "已排期"
						: status === "queued" && queuePosition == null
							? "排队中…"
							: progressLabel(progress, { queuePosition, queueTotal, stageText })}
				</span>
			</div>
		);
	}

	// 文本类节点失败但已有输出（如裂变解析不出资产）：错误条 + 原始输出同显（便于排查格式问题）
	if (isFailed && (display === "text" || display === "script")) {
		const rt = typeof node?.data.resultText === "string" ? node.data.resultText : "";
		if (rt.trim()) {
			if (lod) return <LodBlock label={plugin?.label || "文本"} icon={ScrollText} />;
			return (
				<div className="Qiji-result Qiji-result--filled flex flex-col">
					<div className="shrink-0 px-2 py-1 text-[9px] leading-snug text-red-400/90 border-b border-red-400/20 bg-red-400/5">
						{errorMsg || "生成失败"}
					</div>
					<div className="Qiji-result__text Qiji-scroll-thin flex-1 min-h-0 text-[10px] leading-normal p-2.5 whitespace-pre-wrap">{previewText(rt)}</div>
				</div>
			);
		}
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

	// 上传节点（display=file）：按文件真实类型自适应渲染
	if (display === "file") {
		const fileKind = uploadKind(asset?.kind, node?.data.fileMime);
		if (!asset && !node?.data.fileUri) {
			return (
				<div className="Qiji-result flex flex-col items-center justify-center gap-1 text-muted-foreground select-none text-[10px] opacity-65 font-medium">
					<ScrollText className="h-4.5 w-4.5 opacity-50" />
					<span>点击上传本地文件</span>
				</div>
			);
		}
		const uri = displayUri || asset?.uri || node?.data.fileUri || "";
		if (fileKind === "image") return <ImageResult uri={uri} name={asset?.name} onResolutionChange={onResolutionChange} />;
		if (fileKind === "video") return lod ? <LodBlock label={asset?.name || "视频"} icon={Film} /> : <VideoResult uri={uri} name={asset?.name} onResolutionChange={onResolutionChange} />;
		if (fileKind === "audio") return lod ? <LodBlock label={asset?.name || "音频"} icon={AudioLines} /> : <AudioWaveCard uri={uri} name={asset?.name} nodeId={nodeId} />;
		// 文本/文档
		return (
			<div className="Qiji-result Qiji-result--filled flex flex-col items-center justify-center p-2 text-center w-full h-full">
				<ScrollText className="h-7 w-7 mb-1 text-sky-400" />
				<span className="text-[10px] text-foreground font-medium truncate max-w-full px-1.5" title={asset?.name || node?.data.fileName}>
					{asset?.name || node?.data.fileName || "未命名文件"}
				</span>
				<span className="text-[9px] text-muted-foreground mt-0.5 select-none">已载入素材</span>
			</div>
		);
	}

	// 文本 / 脚本 / 分析类（display=text）：
	//  - 种子节点：显示其可编辑文本（=自己的内容）。
	//  - 处理型文本节点（资产拆分/分集/智能拆分/故事板）：**显示输入内容**（自己的 prompt 或上游文本）；
	//    其生成结果由下游「文本」节点承载（emitResultText / 裂变）。
	if (display === "text" || display === "script") {
		if (lod) return <LodBlock label={plugin?.label || "文本"} icon={ScrollText} />;
		const rt = typeof node?.data.resultText === "string" ? node.data.resultText : "";
		// 资产拆分：结果用资产模式同款统计面板展现（角色/场景/物品/生物/群像/变体 + 视觉圣经）
		if (node?.type === "asset.split" && rt.trim()) return <AssetSplitStats text={rt} />;
		const pp = typeof params.prompt === "string" ? (params.prompt as string) : "";
		const isSeed = plugin?.nodeKind === "seed";
		const upstreamInput = (): string => {
			if (!node) return "";
			// 单输入点：按上游节点类型取文本（文本/对话/种子），不依赖端口名
			const all = useCanvasStore.getState().nodes;
			const texts: string[] = [];
			for (const e of Object.values(edges)) {
				if (e.target !== nodeId) continue;
				const up = all[e.source];
				if (!up) continue;
				const upPlugin = getPlugin(up.type);
				const isTextSrc = upPlugin?.displayKind === "text" || upPlugin?.displayKind === "chat" || upPlugin?.nodeKind === "seed";
				if (!isTextSrc) continue;
				const t = typeof up.data.resultText === "string" && up.data.resultText.trim()
					? up.data.resultText
					: typeof up.data.params.prompt === "string" ? (up.data.params.prompt as string) : "";
				if (t.trim()) texts.push(t);
			}
			return texts.join("\n\n");
		};
		// 处理型文本节点（资产拆分/智能推理等）：**结果优先**——有 resultText 显示结果
		// （流式期间也是它，避免"打完字突然换回输入"），否则显示输入（自己的 prompt 或上游文本）。
		const text = (isSeed ? pp || rt : rt.trim() ? rt : pp.trim() ? pp : upstreamInput()) || "";
		if (!text) {
			return (
				<div className="Qiji-result">
					<span className="text-[10px] opacity-65 select-none font-medium">未生成</span>
				</div>
			);
		}
		return (
			<div className="Qiji-result Qiji-result--filled">
				<div className="Qiji-result__text Qiji-scroll-thin text-[10px] leading-normal p-2.5 whitespace-pre-wrap">{previewText(text)}</div>
			</div>
		);
	}

	// 图片 / 视频 / 音频：未生成时，若已填提示词（如资产拆分裂变填好的出图提示词）则预览它。
	// 注：垫图素材是「输入」，改在操作面板显示（见 NodeRefMaterials），不再叠在节点体上。
	let media: ReactNode;
	if (!asset) {
		const pp = typeof params.prompt === "string" ? (params.prompt as string) : "";
		if (lod) return <LodBlock label={plugin?.label || "未生成"} icon={ImageOff} />;
		media = pp.trim() ? (
			<div className="Qiji-result Qiji-result--filled">
				<div className="Qiji-result__text Qiji-scroll-thin text-[10px] leading-normal p-2.5 whitespace-pre-wrap text-muted-foreground">{previewText(pp)}</div>
			</div>
		) : (
			<div className="Qiji-result">
				<span className="flex flex-col items-center gap-1 text-muted-foreground select-none text-[10px] opacity-65 font-medium">
					<ImageOff className="h-4.5 w-4.5 opacity-50" />
					<span>未生成</span>
				</span>
			</div>
		);
	} else if (display === "image") {
		// 图片在低缩放下保留：GPU 合成便宜，且缩略图是全览时的重要地标
		media = <ImageResult uri={displayUri || asset.uri} name={asset.name} onResolutionChange={onResolutionChange} />;
	} else if (display === "video") {
		// 视频元素占解码器/内存，低缩放下换占位块（zoom 回升自动重挂载）
		media = lod
			? <LodBlock label={asset.name || "视频"} icon={Film} />
			: <VideoResult uri={displayUri || asset.uri} name={asset.name} onResolutionChange={onResolutionChange} />;
	} else if (display === "audio") {
		media = lod
			? <LodBlock label={asset.name || "音频"} icon={AudioLines} />
			: <AudioWaveCard uri={displayUri || asset.uri} name={asset.name} nodeId={nodeId} />;
	} else {
		media = <div className="Qiji-result"><span className="text-[10px] opacity-65 select-none font-medium">未生成</span></div>;
	}

	// 图片/视频节点抽屉式堆叠：多次生成/并入的结果都留在 resultHistory——除堆叠外观（BaseNode 卡片纸边
	// .Qiji-node--stacked）+ 层数角标外与单节点无异；角标点击/右键「打开堆叠」/快捷键 C 展开抽屉
	// （StackDrawer，BaseNode 渲染在节点右侧）。计数含主图（老节点可能只有主图没 history）。
	const history = node?.data.resultHistory || [];
	const stackCount = assetId && !history.includes(assetId) ? history.length + 1 : history.length;
	const stackable = (display === "image" || display === "video") && stackCount > 1 && !lod;
	if (!stackable) return media;
	return (
		<div className="relative w-full h-full">
			{media}
			{/* 层数角标：开/收抽屉（堆叠纸边观感在 BaseNode 卡片层——节点体 overflow:hidden 会裁掉这里的出界元素） */}
			<button
				onClick={(e) => {
					e.stopPropagation();
					useUiStore.getState().setStackDrawerNodeId(drawerOpen ? null : nodeId);
				}}
				onDoubleClick={(e) => e.stopPropagation()}
				title={`堆叠（${stackCount}）——打开抽屉查看/设主图/拖出复制（快捷键 C）`}
				className={`nodrag absolute bottom-1 right-1 z-10 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold cursor-pointer transition-colors ${
					drawerOpen
						? "border-[color:var(--node-accent,#8b5cf6)] bg-black/80 text-white"
						: "border-white/15 bg-black/60 text-white/85 hover:bg-black/80"
				}`}
			>
				<Layers className="h-3 w-3" />{stackCount}
			</button>
		</div>
	);
}

/** asset.kind / mime → 上传节点的展示类型 */
function uploadKind(assetKind?: string, mime?: string): "image" | "video" | "audio" | "text" {
	if (assetKind === "image" || assetKind === "video" || assetKind === "audio") return assetKind;
	if (mime?.startsWith("image/")) return "image";
	if (mime?.startsWith("video/")) return "video";
	if (mime?.startsWith("audio/")) return "audio";
	return "text";
}

function ImageResult({
	uri,
	name,
	onResolutionChange,
}: {
	uri: string;
	name?: string;
	onResolutionChange?: (resStr: string, w: number, h: number) => void;
}) {
	return (
		<div
			className="Qiji-result Qiji-result--filled"
			title="双击放大"
			onDoubleClick={(e) => {
				e.stopPropagation();
				openLightbox({ uri, name, media: "image" });
			}}
		>
			<img
				src={uri}
				alt={name}
				className="Qiji-result__img"
				draggable={false}
				onLoad={(e) => {
					const img = e.currentTarget;
					onResolutionChange?.(`${img.naturalWidth} × ${img.naturalHeight}`, img.naturalWidth, img.naturalHeight);
				}}
			/>
		</div>
	);
}

function VideoResult({
	uri,
	name,
	onResolutionChange,
}: {
	uri: string;
	name?: string;
	onResolutionChange?: (resStr: string, w: number, h: number) => void;
}) {
	const ref = useRef<HTMLVideoElement>(null);
	// 始终隐藏原生控制条/进度条；悬停时静音自动播放，移出暂停。双击放大（灯箱内带完整控制条/全屏）。
	return (
		<div
			className="Qiji-result Qiji-result--filled"
			title="悬停播放 · 双击放大"
			onMouseEnter={() => {
				const v = ref.current;
				if (v) {
					v.muted = true;
					v.play().catch(() => {});
				}
			}}
			onMouseLeave={() => {
				const v = ref.current;
				if (v) v.pause();
			}}
			onDoubleClick={(e) => {
				e.stopPropagation();
				openLightbox({ uri, name, media: "video" });
			}}
		>
			<video
				ref={ref}
				src={uri}
				className="Qiji-result__video"
				muted
				playsInline
				preload="metadata"
				// 纯展示：不拦截指针事件，点击/拖拽交给节点本体（选中/聚焦/打开面板/拖动）
				style={{ pointerEvents: "none" }}
				onLoadedMetadata={(e) => {
					const v = e.currentTarget;
					onResolutionChange?.(`${v.videoWidth} × ${v.videoHeight}`, v.videoWidth, v.videoHeight);
				}}
			/>
		</div>
	);
}

// 音频结果渲染已重做为 AudioWaveCard（波形+单播放按钮，无进度条；双击灯箱才有进度条）——
// 旧原生 <audio controls> 形态（节点又高又空 + 进度条吞指针事件致拖放「粘鼠标」）勿回退，见 AudioWave.tsx。
