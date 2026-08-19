import { useState, useMemo, useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import type { CSSProperties } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Play, Sparkles, ChevronDown, FileText } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { ParamControl } from "./ParamControls";
import { NodePromptEditor, type NodePromptEditorHandle } from "./NodePromptEditor";
import { NodeMaterialBay } from "@/nodes/NodeMaterialBay";
import { getNodeMaterialItems, importAssetToNode } from "@/canvas/nodeMaterials";
import { matchNodeDraftAssets } from "@/lib/assetMatch";
import { PromptExpandButton } from "@/components/PromptExpandButton";
import { getAdapter } from "@/services/modelAdapter";
import { useUiStore } from "@/store/uiStore";
import { getPlugin } from "@/nodes/pluginRegistry";
import { dispatchCommand } from "@/command/dispatch";
import { getChannelModelsForNodeType, resolveActiveModelKey, catalogFamilyOrder } from "@/services/adapters/channelAdapter";
import { modelFamilies, familyOf, modelForFamily, modelForSource, channelOf, type FamilyGroup } from "@/services/adapters/localChannels";
import { useCatalogStore } from "@/store/catalogStore";
import { useSettingsStore } from "@/store/settingsStore";
import { ProcessInfoPanel, isProcessResultNode } from "./ProcessInfoPanel";
import { imageResolutionOptions, clampImageResolution } from "@/lib/genParams";
import { adaptParamsToSchema, schemaForNodeModel, type ParamFieldLike } from "@/lib/modelParamAdapt";
import { listPresetOptions, listPresetSchemes } from "@/lib/presetSchemes";
import { modelNoteText } from "@/lib/modelNote";
import { smartInferContext } from "@/lib/inferUpstream";

const panelTransition = { duration: 0.18 };

/**
 * 局部悬浮上下文操作面板：
 * - 大小是固定的（与整个窗口固定），不跟随画布的 zoom 缩放。
 * - 位置跟随节点，居于选中节点正下方。
 * - 参数精简化折叠，通过中间胶囊汇总按钮向下展开二级面板。
 */
export function OperationPanel({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const runtime = useCanvasStore((s) => s.runtime[nodeId]);


	const [activePopoverKey, setActivePopoverKey] = useState<string | null>(null);
	const promptRef = useRef<NodePromptEditorHandle>(null);
	const [paramPanelExpanded, setParamPanelExpanded] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);
	const { setViewport: rfSetViewport, getViewport: rfGetViewport } = useReactFlow();

	useEffect(() => {
		const handleDocumentClick = () => {
			setActivePopoverKey(null);
			setParamPanelExpanded(false);
		};
		document.addEventListener("click", handleDocumentClick);
		return () => {
			document.removeEventListener("click", handleDocumentClick);
		};
	}, []);

	// 下拉菜单超出屏幕下缘 → 平滑上移画布视角把它露全（面板随节点走，视角上移即整体上移）
	useEffect(() => {
		if (!activePopoverKey && !paramPanelExpanded) return;
		const t = setTimeout(() => {
			const dd = wrapRef.current?.querySelector("[data-dropdown]") as HTMLElement | null;
			if (!dd) return;
			const overflow = dd.getBoundingClientRect().bottom - (window.innerHeight - 12);
			if (overflow > 0) {
				const vp = rfGetViewport();
				rfSetViewport({ ...vp, y: vp.y - overflow }, { duration: 220 });
			}
		}, 40); // 等下拉完成挂载/入场动画起始后测量
		return () => clearTimeout(t);
	}, [activePopoverKey, paramPanelExpanded, rfGetViewport, rfSetViewport]);

	const channelModelOptions = useMemo(() => getChannelModelsForNodeType(node?.type ?? "text"), [node]);

	// 智能推理节点：可用用途按**上游类型**动态收敛（上游智能推理→仅单卡；上游剧集分集→仅多卡+拆分；
	// 无/其他上游→全部）——订阅连线，接/断上游后模板下拉即时切换。与执行允许集同一把尺（inferUpstream）。
	const edgesMap = useCanvasStore((s) => s.edges);
	const inferCtx = useMemo(
		() => (node?.type === "smart.infer" ? smartInferContext(node.id, useCanvasStore.getState().nodes, edgesMap) : null),
		[node, edgesMap],
	);

	// 该节点可用的提示词模板：**按节点用途（purpose）过滤**，与执行/服务端解析同一把尺。
	// 不再用 nodeTypes 白名单——那份数据还是旧画布节点类型（如 "text"），会把正确模板
	// （资产提取）滤掉、反把 nodeTypes 为空的无关模板（智能拆分）放进来 → 一选就调错提示词。
	// 「内部」分类模板（如自动分集）不进选择器。
	const catalogVersion = useCatalogStore((s) => s.catalog?.version);
	const templateOptions = useMemo(() => {
		const plugin = node ? getPlugin(node.type) : null;
		// 用途集合：智能推理按上游动态（inferCtx），其余节点缺省=仅 spec.purpose / spec 静态多用途集
		const purposes = inferCtx?.purposes ?? plugin?.templatePurposes ?? (plugin?.purpose ? [plugin.purpose] : []);
		if (!purposes.length) return [];
		const cat = useCatalogStore.getState();
		const seen = new Set<string>();
		return purposes
			.flatMap((p) => cat.templatesByPurpose(p))
			.filter((t) => t.category !== "内部" && !seen.has(t.id) && (seen.add(t.id), true));
	}, [node?.type, inferCtx, catalogVersion]);

	const view = useMemo(() => {
		if (!node) return null;
		const def = getPlugin(node.type);
		if (!def) return null;
		const params = node.data.params;
		const modelKey = resolveActiveModelKey(node.type, params.model, def.defaultModel);

		// 零兜底（§9）：解析不到模型就如实呈现「选择模型」，运行时直接打开设置引导配置。
		// ⚠ 绝不回退 adapters[0]——历史上曾借此选中 __fallback 假适配器并真发请求。
		const adapter = getAdapter(modelKey) ?? null;
		const mode = adapter
			? (typeof params.mode === "string" && adapter.modes.some((m) => m.key === params.mode)
				? adapter.modes.find((m) => m.key === params.mode)!
				: adapter.modes[0])
			: null;
		const cost = adapter && mode ? adapter.estimateCost(mode.key, params) : 0;
		return { def, params, adapter, modelKey, modeKey: mode?.key ?? "", mode, cost };
	}, [node, channelModelOptions]);

	// 监听视口坐标以计算屏幕绝对位置
	const viewport = useCanvasStore((s) => s.viewport);
	// 模型备注（第166轮）：悬浮积分图标显示——管理端备注优先，未设=默认参考素材上限（matLimits 派生）
	const noteModel = useCatalogStore((s) => {
		const key = view?.adapter?.key;
		return key ? s.catalog?.models.find((mm) => mm.id === key) : undefined;
	});
	// 订阅自定义预设：变化时刷新功能栏「预设方案」下拉（presetSchemes 在 render 里读 getState）
	useSettingsStore((s) => s.customPresets);

	const prompt = typeof (node?.data?.params?.prompt) === "string" ? node.data.params.prompt : "";

	// 参数摘要：必须在任何 early return 之前调用（hooks 顺序稳定）。node/view 缺失时用空表兜底。
	// 文本类节点**不开放** catalog 模型参数（温度/最大长度等）——与资产模式一致（客户端按用途固定下发），
	// 只保留 spec 固定参数（分集方式/推理模式/质量/比例等）；仅媒体节点回退 catalog 模型参数。
	const isTextForParams = !view || view.def.capability === "text" || view.def.capability == null;
	const paramSchemaRaw = view
		? (view.adapter?.paramsFromMode
			// 第三方本地渠道（LibTV/即梦）：参数按第三方要求（mode.paramsSchema），不用节点 spec 固定参数
			? view.mode?.paramsSchema ?? []
			: (view.def.params && view.def.params.length
				? view.def.params
				: (isTextForParams ? [] : view.mode?.paramsSchema ?? [])))
		: [];
	// 生图分辨率档由服务端按模型下发（catalog params.resolution 枚举，管理端可改）——覆盖 spec 静态档位
	const catalogImgModel = useCatalogStore((s) => (view?.def.capability === "image" ? s.model(view.modelKey) : undefined));
	const paramSchemaForSummary = view?.def.capability === "image"
		? paramSchemaRaw.map((f) => {
			if (f.key !== "resolution" || f.type !== "enum") return f;
			const opts = imageResolutionOptions(catalogImgModel);
			return { ...f, options: opts.map((r) => r.v), default: clampImageResolution(f.default, opts) };
		})
		: paramSchemaRaw;
	const paramsForSummary = view?.params ?? {};
	// 图片节点与视频面板同款简约格式：只拼值不带标题（high·16:9·2k）；其余节点保留「标题: 值」
	const summaryValuesOnly = view?.def.capability === "image";
	const paramsSummary = useMemo(() => {
		if (summaryValuesOnly) {
			return paramSchemaForSummary
				.filter((f) => f.type === "enum" || f.type === "number")
				.map((f) => {
					const v = paramsForSummary[f.key] ?? f.default;
					return v === undefined ? null : `${v}${f.unit ?? ""}`;
				})
				.filter(Boolean)
				.join("·") || "参数";
		}
		return paramSchemaForSummary
			.map((field) => {
				const val = paramsForSummary[field.key] ?? field.default;
				return `${field.label}: ${val}`;
			})
			.join("·") || "参数";
	}, [paramSchemaForSummary, paramsForSummary, summaryValuesOnly]);

	if (!node || !view) return null;
	const { def, params, adapter, mode, cost } = view;
	// 家族三级折叠（第163轮）：图像节点「家族（模型种类）→ 渠道/线路 → 模型」与视频面板同款；
	// 文本/音频不折叠（模型平铺，行为不变）。视频节点走独立 VideoOperationPanel。
	const srcFamilies = def.capability === "image"
		? modelFamilies(
			channelModelOptions.map((o) => ({ id: o.id, label: o.modelName, modeId: o.modeId, modeName: o.modeName, familyId: o.familyId, familyName: o.familyName })),
			catalogFamilyOrder(),
		)
		: null;
	const famGrp = srcFamilies ? familyOf(adapter?.key, srcFamilies) : null;
	const famChannels = famGrp?.channels ?? [];
	const srcCh = srcFamilies ? channelOf(adapter?.key, famChannels) : null;
	// 下拉条目：图像=家族列表（选中即进该家族，款式由旁边两个 pill 细选）；文本/音频=扁平模型列表
	const modelDropdownOptions: { id: string; name: string; family?: FamilyGroup }[] = srcFamilies
		? srcFamilies.map((f) => ({ id: modelForFamily(f.familyId, adapter?.key, srcFamilies), name: f.familyName, family: f }))
		: channelModelOptions.map((opt) => ({ id: opt.id, name: opt.modelName }));
	// 出图预设方案（图片节点专属）：插入按钮放面板底部功能栏（读 catalog，随其订阅热更）
	const presetSchemes = def.capability === "image" ? listPresetSchemes() : [];
	// 参数表单：spec 固定参数优先；文本类节点不回退 catalog 模型参数（同上方摘要逻辑）。
	const paramSchema = paramSchemaForSummary;
	// 脚本节点（如剧集分集）不调模型：隐藏模型/模板选择。
	const isScript = def.nodeKind === "script";
	// 媒体生成节点（图片/视频/音频）：提示词即内容、不走推理模板 → 隐藏提示词模板选择。
	const isMediaGen = def.capability === "image" || def.capability === "video" || def.capability === "audio";
	const running = runtime?.status === "running" || runtime?.status === "queued";

	const selectedTemplateId = typeof params.templateId === "string" ? params.templateId : "";
	const selectedTemplate = templateOptions.find((t) => t.id === selectedTemplateId);
	// 实际生效模板（无「默认」外壳，显示真实模板名）：
	// 节点显式选择 > spec 默认模板（如 智能推理=单分镜）> 该 purpose 的服务端默认（与执行逻辑一致）。
	const catalogState = useCatalogStore.getState();
	// 默认解析不传 nodeType（nodeTypes 数据是旧节点类型）：纯按 purpose，与服务端 getDefaultTemplate 一致。
	// 智能推理节点的默认模板按上游场景（inferCtx：单卡默认/多卡默认），与执行回退一致。
	const panelDefaultTplId = inferCtx?.defaultTemplateId ?? def.defaultTemplateId;
	const effectiveTemplate =
		selectedTemplate
		?? (panelDefaultTplId ? catalogState.catalog?.templates.find((t) => t.id === panelDefaultTplId) : undefined)
		?? (def.purpose ? catalogState.defaultTemplate(def.purpose) : undefined);
	const templateLabel = effectiveTemplate?.name ?? "无可用模板";

	const setParam = (patch: Record<string, unknown>) =>
		dispatchCommand({ type: "updateNodeParams", id: nodeId, params: patch });

	// 目标模型生效的参数表（与上方 paramSchemaRaw/paramSchemaForSummary 同一把尺，只是换成目标模型解析）
	const schemaOfModel = (mkey: string): ParamFieldLike[] => {
		const ad = getAdapter(mkey);
		return schemaForNodeModel(node.type, mkey, {
			paramsFromMode: ad?.paramsFromMode,
			modeSchema: ad?.modes?.[0]?.paramsSchema as ParamFieldLike[] | undefined,
		});
	};

	/** 切换模型：把已选参数（质量/比例/分辨率等）收敛到新模型的可用档位再落库，避免显示越档值 */
	const switchModel = (targetId: string) => {
		const firstMode = getAdapter(targetId)?.modes?.[0]?.key;
		const patch: Record<string, unknown> = { model: targetId };
		if (firstMode) patch.mode = firstMode;
		Object.assign(patch, adaptParamsToSchema(schemaOfModel(targetId), params));
		setParam(patch);
		setActivePopoverKey(null);
	};

	// 原文节点（分镜n原文）：展示内容(resultText)即推理输入(prompt)——编辑提示词时同步刷新显示，
	// 重跑推理即按编辑后的原文（推理用 params.prompt，见 pluginRegistry）。
	const isScriptNode = /^分镜\d+原文$/.test(String(node.data.title ?? ""));
	const onPromptEdit = (v: string) => {
		setParam({ prompt: v });
		if (isScriptNode) {
			const cs = useCanvasStore.getState();
			const n = cs.nodes[nodeId];
			if (n) useCanvasStore.setState({ nodes: { ...cs.nodes, [nodeId]: { ...n, data: { ...n.data, resultText: v } } } });
		}
	};


	const onRun = () => {
		// 无可用模型（catalog 无该能力模型）：请求不发出，直接打开「设置 → 管理端」引导连接（零兜底，不落假值）。
		// isScript（本地脚本节点，如剧集分集）不调模型，无需模型即可运行。
		if (!isScript && def.capability && (!adapter || !mode)) {
			useUiStore.getState().openModelSettings();
			return;
		}
		if (adapter && mode) setParam({ model: adapter.key, mode: mode.key });
		dispatchCommand({ type: "run", nodeId });
	};





	// 动态计算该节点在屏幕视图空间下的中心底端坐标 (100% 抵御 zoom 缩放)
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

	// ── 处理类/只读结果节点（图像超分等）：面板锁定为信息展示（共享 ProcessInfoPanel） ──
	if (isProcessResultNode(params)) return <ProcessInfoPanel nodeId={nodeId} />;

	return (
		<div
			ref={wrapRef}
			style={wrapperStyle}
			data-node-panel
			className="pointer-events-auto flex flex-col items-center gap-2 w-fit"
			onClick={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.stopPropagation()}
			onPointerDown={(e) => e.stopPropagation()}
		>
			{/* ─ 主操作面板 ── */}
			<motion.div
				initial={{ y: 10, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				exit={{ y: 10, opacity: 0 }}
				transition={panelTransition}
				style={{
					background: "rgba(22, 27, 38, 0.98)",
					border: "1px solid rgba(255, 255, 255, 0.1)",
					backdropFilter: "blur(20px)",
					boxShadow: "0 16px 48px rgba(0, 0, 0, 0.6)",
				}}
				className="w-[760px] rounded-2xl text-foreground flex flex-col overflow-visible"
			>
				{/* 上列 80%：提示词 & 素材（输入）；底部留白压缩（红框空隙瘦身） */}
				<div className="flex flex-col px-5 pt-5 pb-2 flex-1 min-h-[140px] border-b border-white/5">
					{/* 素材区（可编辑）：上游连线素材(前) + 自加素材(后)，＋/拖入/粘贴添加；最右为提示词放大按钮 */}
					<NodeMaterialBay
						nodeId={nodeId}
						rightAction={<PromptExpandButton title="编辑提示词" getValue={() => prompt} onSave={onPromptEdit} placeholder="输入提示词…" getExtra={() => <NodeMaterialBay nodeId={nodeId} />} getMentions={() => getNodeMaterialItems(nodeId)} onImport={(cand) => importAssetToNode(nodeId, cand)} getPresets={def.capability === "image" ? () => listPresetOptions() : undefined} onMatchAssets={def.displayKind === "image" || def.displayKind === "video" ? (draft) => matchNodeDraftAssets(nodeId, draft) : undefined} />}
					/>

					{/* 提示词输入区（自适应高度，超出内部滚动，不撑高面板）*/}
					<div className="min-w-0 relative mt-1">
						<NodePromptEditor ref={promptRef} nodeId={nodeId} prompt={prompt} onChange={onPromptEdit} placeholder={mode?.inputHint ?? "输入提示词..."} />
						
					</div>
				</div>

				{/* 下列 20%：可选功能区（py 压缩） */}
				<div className="flex items-center justify-between gap-3 px-5 py-2 shrink-0">
					<div className="flex items-center gap-2 min-w-0">
						{/* 模型选择（脚本节点不调模型则隐藏；置于滚动容器外，避免上弹下拉被 overflow 裁剪） */}
						{!isScript && (<div className="relative shrink-0">
							<button
								onClick={(e) => {
									e.stopPropagation();
									setParamPanelExpanded(false);
									setActivePopoverKey(activePopoverKey === "model" ? null : "model");
								}}
								className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 text-foreground cursor-pointer whitespace-nowrap transition-colors ${activePopoverKey === "model" ? "bg-white/10 border-white/10" : "hover:bg-white/8"
									}`}
							>
								{srcFamilies ? (famGrp?.familyName ?? "选择模型") : (adapter?.displayName ?? "选择模型")}
								<ChevronDown className="h-3 w-3 text-muted-foreground" />
							</button>
							<AnimatePresence>
								{activePopoverKey === "model" && (
									<motion.div
										data-dropdown
										initial={{ y: -8, opacity: 0 }}
										animate={{ y: 0, opacity: 1 }}
										exit={{ y: -8, opacity: 0 }}
										transition={panelTransition}
										style={{
											position: "absolute",
											top: "100%",
											left: 0,
											marginTop: "6px",
											background: "rgba(22, 27, 38, 0.98)",
											border: "1px solid rgba(255, 255, 255, 0.12)",
											backdropFilter: "blur(20px)",
											boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
											zIndex: 1010,
										}}
										className="rounded-xl overflow-visible min-w-[180px] py-1"
										onClick={(e) => e.stopPropagation()}
									>
										{/* 家族列表（图像节点=按家族折叠：GPT Image 2 / Nano Banana…各一项、线路/款式由旁边
										    两个 pill 细选；文本/音频节点=扁平模型列表，行为不变） */}
										{modelDropdownOptions.length === 0 && (
											<div className="px-3.5 py-2.5 text-xs text-muted-foreground">暂无可用模型（请在管理端配置）</div>
										)}
										{modelDropdownOptions.map((opt) => {
											const selected = opt.family
												? famGrp?.familyId === opt.family.familyId
												: opt.id === adapter?.key;
											return (
												<button
													key={opt.family ? (opt.family.familyId || "__other") : opt.id}
													onClick={() => {
														// 家族项：modelForFamily 已保证在家族内保持款式、否则取家族第一款
														switchModel(opt.id);
													}}
													className={`flex items-center justify-between w-full px-3.5 py-2.5 text-xs transition-colors cursor-pointer text-left ${selected
															? "bg-white/10 text-white font-medium"
															: "text-muted-foreground hover:bg-white/5 hover:text-foreground"
														}`}
												>
													<span className="flex-1 pr-2">{opt.name}</span>
													{selected && <span className="text-green-400 text-[10px] ml-2">✓</span>}
												</button>
											);
										})}
									</motion.div>
								)}
							</AnimatePresence>
						</div>)}

						{/* 「渠道/线路」二级选择（图像节点，家族 pill 旁）：家族内的源（模式名等） */}
						{!isScript && famGrp && famChannels.length > 0 && (
							<div className="relative shrink-0">
								<button
									title="渠道/线路：同一模型家族在不同渠道的线路"
									onClick={(e) => {
										e.stopPropagation();
										setParamPanelExpanded(false);
										setActivePopoverKey(activePopoverKey === "line" ? null : "line");
									}}
									className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 text-foreground cursor-pointer whitespace-nowrap transition-colors ${activePopoverKey === "line" ? "bg-white/10 border-white/10" : "hover:bg-white/8"}`}
								>
									{srcCh?.channel ?? "选择线路"}
									<ChevronDown className="h-3 w-3 text-muted-foreground" />
								</button>
								<AnimatePresence>
									{activePopoverKey === "line" && (
										<motion.div
											data-dropdown
											initial={{ y: -8, opacity: 0 }}
											animate={{ y: 0, opacity: 1 }}
											exit={{ y: -8, opacity: 0 }}
											transition={panelTransition}
											style={{
												position: "absolute",
												top: "100%",
												left: 0,
												marginTop: "6px",
												background: "rgba(22, 27, 38, 0.98)",
												border: "1px solid rgba(255, 255, 255, 0.12)",
												backdropFilter: "blur(20px)",
												boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
												zIndex: 1010,
											}}
											className="rounded-xl overflow-visible min-w-[180px] py-1"
											onClick={(e) => e.stopPropagation()}
										>
											{famChannels.map((ch) => {
												const selected = srcCh?.channel === ch.channel;
												return (
													<button
														key={ch.channel}
														onClick={() => {
															switchModel(modelForSource(`src:${ch.channel}`, adapter?.key, famChannels));
														}}
														className={`flex items-center justify-between w-full px-3.5 py-2.5 text-xs transition-colors cursor-pointer text-left ${selected
															? "bg-white/10 text-white font-medium"
															: "text-muted-foreground hover:bg-white/5 hover:text-foreground"}`}
													>
														<span className="flex-1 pr-2">{ch.channel}</span>
														{selected && <span className="text-green-400 text-[10px] ml-2">✓</span>}
													</button>
												);
											})}
										</motion.div>
									)}
								</AnimatePresence>
							</div>
						)}

						{/* 「模型」三级选择（图像节点，线路 pill 旁）：线路内的具体款式 */}
						{!isScript && srcCh && (
							<div className="relative shrink-0">
								<button
									onClick={(e) => {
										e.stopPropagation();
										setParamPanelExpanded(false);
										setActivePopoverKey(activePopoverKey === "variant" ? null : "variant");
									}}
									className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 text-foreground cursor-pointer whitespace-nowrap transition-colors ${activePopoverKey === "variant" ? "bg-white/10 border-white/10" : "hover:bg-white/8"}`}
								>
									{srcCh.choices.find((c) => c.id === adapter?.key)?.variantLabel ?? "选择模型"}
									<ChevronDown className="h-3 w-3 text-muted-foreground" />
								</button>
								<AnimatePresence>
									{activePopoverKey === "variant" && (
										<motion.div
											data-dropdown
											initial={{ y: -8, opacity: 0 }}
											animate={{ y: 0, opacity: 1 }}
											exit={{ y: -8, opacity: 0 }}
											transition={panelTransition}
											style={{
												position: "absolute",
												top: "100%",
												left: 0,
												marginTop: "6px",
												background: "rgba(22, 27, 38, 0.98)",
												border: "1px solid rgba(255, 255, 255, 0.12)",
												backdropFilter: "blur(20px)",
												boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
												zIndex: 1010,
											}}
											className="rounded-xl overflow-visible min-w-[200px] py-1"
											onClick={(e) => e.stopPropagation()}
										>
											{srcCh.choices.map((c) => {
												const selected = c.id === adapter?.key;
												return (
													<button
														key={c.id}
														onClick={() => {
															switchModel(c.id);
														}}
														className={`flex items-center justify-between w-full px-3.5 py-2.5 text-xs transition-colors cursor-pointer text-left ${selected
																? "bg-white/10 text-white font-medium"
																: "text-muted-foreground hover:bg-white/5 hover:text-foreground"
															}`}
													>
														<span className="flex-1 pr-2">{c.variantLabel}</span>
														{selected && <span className="text-green-400 text-[10px] ml-2">✓</span>}
													</button>
												);
											})}
										</motion.div>
									)}
								</AnimatePresence>
							</div>
						)}

						{/* 提示词模板选择（脚本/媒体生成节点隐藏；按节点 purpose 过滤）。
						    无「跟随默认」占位：未显式选择时直接勾选实际生效的那条模板（与执行逻辑一致）。 */}
						{!isScript && !isMediaGen && !!def.purpose && templateOptions.length > 0 && (
							<div className="relative shrink-0">
								<button
									onClick={(e) => {
										e.stopPropagation();
										setParamPanelExpanded(false);
										setActivePopoverKey(activePopoverKey === "template" ? null : "template");
									}}
									title="提示词模板"
									className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 text-foreground cursor-pointer whitespace-nowrap transition-colors ${activePopoverKey === "template" ? "bg-white/10 border-white/10" : "hover:bg-white/8"
										}`}
								>
									<FileText className="h-3 w-3 text-muted-foreground" />
									{templateLabel}
									<ChevronDown className="h-3 w-3 text-muted-foreground" />
								</button>
								<AnimatePresence>
									{activePopoverKey === "template" && (
										<motion.div
											data-dropdown
											initial={{ y: -8, opacity: 0 }}
											animate={{ y: 0, opacity: 1 }}
											exit={{ y: -8, opacity: 0 }}
											transition={panelTransition}
											style={{
												position: "absolute",
												top: "100%",
												left: 0,
												marginTop: "6px",
												background: "rgba(22, 27, 38, 0.98)",
												border: "1px solid rgba(255, 255, 255, 0.12)",
												backdropFilter: "blur(20px)",
												boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
												zIndex: 1010,
											}}
											className="rounded-xl overflow-visible min-w-[200px] py-1"
											onClick={(e) => e.stopPropagation()}
										>
											{templateOptions.map((t) => {
												const isEffective = t.id === effectiveTemplate?.id;
												return (
													<button
														key={t.id}
														onClick={() => {
															setParam({ templateId: t.id, purpose: t.purpose });
															setActivePopoverKey(null);
														}}
														title={t.bodyPreview ?? ""}
														className={`flex items-center justify-between w-full px-3.5 py-2.5 text-xs transition-colors cursor-pointer text-left ${isEffective
																? "bg-white/10 text-white font-medium"
																: "text-muted-foreground hover:bg-white/5 hover:text-foreground"
															}`}
													>
														<span className="flex-1 pr-2">{t.name}</span>
														{isEffective && <span className="text-green-400 text-[10px] ml-2">✓</span>}
													</button>
												);
											})}
										</motion.div>
									)}
								</AnimatePresence>
							</div>
						)}

						{/* 参数汇总胶囊（二级面板对齐其下方展开） */}
						{paramSchema.length > 0 && (
							<div className="relative shrink-0">
								<button
									onClick={(e) => {
										e.stopPropagation();
										setActivePopoverKey(null);
										setParamPanelExpanded(!paramPanelExpanded);
									}}
									className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer whitespace-nowrap ${paramPanelExpanded
											? "bg-white/15 border-white/20 text-white"
											: "bg-white/5 border-white/5 hover:bg-white/8 text-foreground"
										}`}
								>
									{paramsSummary}
									<ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${paramPanelExpanded ? "rotate-180" : ""}`} />
								</button>
								<AnimatePresence>
									{paramPanelExpanded && (
										<ParamSecondary paramsSchema={paramSchema} params={params} setParam={setParam} />
									)}
								</AnimatePresence>
							</div>
						)}

						{/* 预设方案（图片节点，置于参数右侧）：点击插入预设胶囊到提示词光标处，提交时展开为完整预设词 */}
						{presetSchemes.length > 0 && (
							<div className="relative shrink-0">
								<button
									onClick={(e) => {
										e.stopPropagation();
										setParamPanelExpanded(false);
										setActivePopoverKey(activePopoverKey === "preset" ? null : "preset");
									}}
									title="插入出图预设方案（提交时替换为完整预设词）"
									className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer whitespace-nowrap transition-colors"
									style={{ color: "#fcd34d", border: "1px solid rgba(245,158,11,0.4)", background: activePopoverKey === "preset" ? "rgba(245,158,11,0.22)" : "rgba(245,158,11,0.12)" }}
								>
									▦ 预设方案
									<ChevronDown className="h-3 w-3" />
								</button>
								<AnimatePresence>
									{activePopoverKey === "preset" && (
										<motion.div
											data-dropdown
											initial={{ y: -8, opacity: 0 }}
											animate={{ y: 0, opacity: 1 }}
											exit={{ y: -8, opacity: 0 }}
											transition={panelTransition}
											style={{
												position: "absolute",
												top: "100%",
												right: 0,
												marginTop: "6px",
												background: "rgba(22, 27, 38, 0.98)",
												border: "1px solid rgba(255, 255, 255, 0.12)",
												backdropFilter: "blur(20px)",
												boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
												zIndex: 1010,
											}}
											className="rounded-xl overflow-visible w-[288px] max-h-[300px] overflow-y-auto Qiji-scroll-thin py-1"
											onClick={(e) => e.stopPropagation()}
										>
											{presetSchemes.map((p) => (
												<button
													key={p.id}
													onClick={() => { promptRef.current?.insertPreset(p.id, p.name); setActivePopoverKey(null); }}
													className="block w-full text-left px-3.5 py-2 hover:bg-white/5 cursor-pointer"
												>
													<div className="text-xs font-semibold" style={{ color: "#fcd34d" }}>▦ {p.name}</div>
													<div className="text-[10px] text-muted-foreground mt-0.5" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.body}</div>
												</button>
											))}
										</motion.div>
									)}
								</AnimatePresence>
							</div>
						)}

						{/* 功能动作按钮（横向滚动，胶囊/下拉不在此容器内） */}
						<div className="flex items-center gap-2 min-w-0 overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: "none" }}>
							{def.actions?.map((act) => (
								<button
									key={act.name}
									onClick={() => dispatchCommand({ type: "executeNodeAction", nodeId, actionName: act.name })}
									className="px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 hover:bg-white/8 text-foreground cursor-pointer transition-colors"
								>
									{act.label}
								</button>
							))}
						</div>
					</div>

					{/* 右侧：积分 + 运行按钮 */}
					<div className="flex items-center gap-2.5 shrink-0">
						<span className="flex items-center gap-1 text-xs text-muted-foreground font-semibold">
							{/* 悬浮图标=当前模型备注（第166轮）：管理端备注优先，未设默认显示参考素材上限 */}
							<span className="flex items-center cursor-help" title={modelNoteText(noteModel) || undefined}>
								<Sparkles className="h-3.5 w-3.5 text-amber-400" />
							</span>
							<span>{cost}积分</span>
						</span>
						<button
							onClick={onRun}
							disabled={running}
							className="h-8 w-8 rounded-full p-0 flex items-center justify-center cursor-pointer bg-[color:var(--node-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
							title="运行节点"
						>
							<Play className="h-4 w-4" fill="currentColor" />
						</button>
					</div>
				</div>
			</motion.div>
		</div>
	);
}

/** 参数二级面板：绝对定位锚在「参数汇总胶囊」正下方、左对齐其按钮、向下展开 */
function ParamSecondary({
	paramsSchema,
	params,
	setParam,
}: {
	paramsSchema: any[];
	params: Record<string, any>;
	setParam: (patch: Record<string, unknown>) => void;
}) {
	return (
		<motion.div
			data-dropdown
			initial={{ y: -8, opacity: 0 }}
			animate={{ y: 0, opacity: 1 }}
			exit={{ y: -8, opacity: 0 }}
			transition={panelTransition}
			style={{
				position: "absolute",
				top: "100%",
				left: 0,
				marginTop: "6px",
				background: "rgba(22, 27, 38, 0.98)",
				border: "1px solid rgba(255, 255, 255, 0.1)",
				backdropFilter: "blur(20px)",
				boxShadow: "0 12px 32px rgba(0, 0, 0, 0.5)",
				width: "300px",
				zIndex: 1010,
			}}
			className="rounded-xl p-3 text-foreground flex flex-col gap-2.5"
			onClick={(e) => e.stopPropagation()}
		>
			{paramsSchema.map((field) => {
				const val = params[field.key] ?? field.default;
				const displayVal = String(val) + (field.unit || "");
				return (
					<div key={field.key} className="flex flex-col gap-1">
						<div className="text-[10px] text-muted-foreground font-semibold">{field.label}</div>
						{field.type === "enum" ? (
							<div className="flex flex-wrap gap-1">
								{field.options?.map((opt: string) => (
									<button
										key={opt}
										onClick={() => setParam({ [field.key]: opt })}
										className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all cursor-pointer ${val === opt
												? "bg-white text-black font-semibold"
												: "bg-white/5 text-muted-foreground hover:bg-white/8 hover:text-foreground"
											}`}
									>
										{opt}
									</button>
								))}
							</div>
						) : field.type === "number" ? (
							<div>
								<div className="text-sm font-bold text-white mb-0.5">{displayVal}</div>
								<input
									type="range"
									min={field.min ?? 0}
									max={field.max ?? 100}
									step={field.step ?? 1}
									value={Number(val)}
									onChange={(e) => setParam({ [field.key]: Number(e.target.value) })}
									className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
								/>
							</div>
						) : (
							<div className="p-0.5 min-w-[150px]">
								<ParamControl
									field={field}
									value={val}
									onChange={(next) => setParam({ [field.key]: next })}
								/>
							</div>
						)}
					</div>
				);
			})}
		</motion.div>
	);
}