import { useState, useMemo, useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";
import type { CSSProperties } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Play, Sparkles, ChevronDown } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { getAdapter } from "@/services/modelAdapter";
import { useUiStore } from "@/store/uiStore";
import type { ParamField } from "@/services/adapters/types";
import { getPlugin } from "@/nodes/pluginRegistry";
import { dispatchCommand } from "@/command/dispatch";
import { NodePromptEditor } from "./NodePromptEditor";
import { NodeMaterialBay } from "@/nodes/NodeMaterialBay";
import { getNodeMaterialItems, importAssetToNode } from "@/canvas/nodeMaterials";
import { matchNodeDraftAssets } from "@/lib/assetMatch";
import { PromptExpandButton } from "@/components/PromptExpandButton";
import { getChannelModelsForNodeType, resolveActiveModelKey, catalogFamilyOrder } from "@/services/adapters/channelAdapter";
import { modelFamilies, familyOf, modelForFamily, modelForSource, channelOf, type FamilyGroup } from "@/services/adapters/localChannels";
import { useCatalogStore } from "@/store/catalogStore";
import { estimateCost as estimateCreditCost } from "@/lib/genParams";
import { useRefVideoSeconds } from "@/store/videoDurationStore";
import { METHOD_LABELS, modelMethods, clampMethod } from "@/lib/videoMethods";
import { adaptParamsToSchema, schemaForNodeModel, type ParamFieldLike } from "@/lib/modelParamAdapt";
import { modelNoteText } from "@/lib/modelNote";
import { ProcessInfoPanel, isProcessResultNode } from "./ProcessInfoPanel";

const panelTransition = { duration: 0.18 };

/**
 * 视频节点专用操作面板
 * 匹配截图设计：顶部 tabs + 中间大文本区 + 底部参数胶囊行
 */
export function VideoOperationPanel({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const runtime = useCanvasStore((s) => s.runtime[nodeId]);


	const [activePopoverKey, setActivePopoverKey] = useState<string | null>(null);
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

	// 下拉菜单超出屏幕下缘 → 平滑上移画布视角把它露全（与 OperationPanel 同规则）
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
		}, 40);
		return () => clearTimeout(t);
	}, [activePopoverKey, paramPanelExpanded, rfGetViewport, rfSetViewport]);

	const channelModelOptions = useMemo(() => getChannelModelsForNodeType(node?.type ?? "video"), [node]);

	// 视频模型三级折叠（第163轮）：家族（模型种类）→ 渠道/线路（模式名/LibTV/即梦）→ 模型（款式）。
	// 家族=一级筛选（用户定「以模型为首要筛选」）；家族顺序按 catalog.families 下发序。
	const srcFamilies = useMemo(
		() => modelFamilies(
			channelModelOptions.map((o) => ({ id: o.id, label: o.modelName, modeId: o.modeId, modeName: o.modeName, familyId: o.familyId, familyName: o.familyName })),
			catalogFamilyOrder(),
		),
		[channelModelOptions],
	);

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
		return { def, params, adapter, modeKey: mode?.key ?? "", mode, cost };
	}, [node, channelModelOptions]);

	const prompt = typeof (node?.data?.params?.prompt) === "string" ? node.data.params.prompt : "";

	// 当前模型的 catalog 定义（第131轮：方法 methods / 真人图 officialAssets / 要求档位 params 均按它；本地 CLI 模型无）
	const catModel = useCatalogStore((s) => {
		const key = view?.adapter?.key;
		return key ? s.catalog?.models.find((mm) => mm.id === key) : undefined;
	});
	// 参考视频计费秒数（第143轮）：模型声明 refVideoSecondsWeight 才收集视频素材（上游连线+自加合并序；
	// 订阅画布签名——连线/素材增删即刷新；时长本地读元数据，读出后角标自动更新。实扣以服务端探测为准）
	const refWeight = Number(catModel?.refVideoSecondsWeight) || 0;
	const vidUriSig = useCanvasStore(() =>
		refWeight > 0 && node
			? getNodeMaterialItems(nodeId).filter((it) => it.media === "video").map((it) => it.uri).join("\n")
			: "",
	);
	const refVideoSeconds = useRefVideoSeconds(vidUriSig ? vidUriSig.split("\n") : []);
	// 按时长精确预估积分（与管理端实际扣费同公式）：视频按 (duration + 系数×参考视频秒) × 每秒价。无 catalog 时回退适配器估算。
	const creditEstimate = useCatalogStore((s) => {
		const key = view?.adapter?.key;
		const m = key ? s.catalog?.models.find((mm) => mm.id === key) : undefined;
		return estimateCreditCost(m, view?.params ?? {}, refVideoSeconds);
	});

	// 视口坐标（⚠ hooks 必须全部在下方 early return 之前：面板开着时节点被删，node 变 undefined
	// 走 early return，若此 hook 在 return 之后会触发 "Rendered fewer hooks" 崩溃——存量 bug，勿移回）
	const viewport = useCanvasStore((s) => s.viewport);

	if (!node || !view) return null;
	const { def, params, adapter, mode, cost } = view;
	const running = runtime?.status === "running" || runtime?.status === "queued";

	const setParam = (patch: Record<string, unknown>) =>
		dispatchCommand({ type: "updateNodeParams", id: nodeId, params: patch });

	// 目标模型生效的参数表（与下方 paramSchema 同一把尺，只是换成目标模型解析）
	const schemaOfModel = (mkey: string) => {
		const ad = getAdapter(mkey);
		return schemaForNodeModel(node.type, mkey, {
			paramsFromMode: ad?.paramsFromMode,
			modeSchema: ad?.modes?.[0]?.paramsSchema as ParamFieldLike[] | undefined,
		});
	};

	/**
	 * 切换模型：把「要求」（分辨率/比例/时长）与「方法」一并收敛到新模型的可用档位再落库，
	 * 否则新模型不支持的旧档位会一直显示（提交层虽有收敛，显示与实发不一致）。
	 */
	const switchModel = (targetId: string) => {
		const firstMode = getAdapter(targetId)?.modes?.[0]?.key;
		const catTarget = useCatalogStore.getState().catalog?.models.find((m) => m.id === targetId);
		const patch: Record<string, unknown> = { model: targetId };
		if (firstMode) patch.mode = firstMode;
		Object.assign(patch, adaptParamsToSchema(schemaOfModel(targetId), params));
		if (params.method !== undefined) {
			const m = clampMethod(params.method, modelMethods(catTarget));
			if (m !== params.method) patch.method = m;
		}
		setParam(patch);
		setActivePopoverKey(null);
	};

	// 当前模型所属的 家族 / 渠道线路：家族 pill + 线路 pill + 「模型」pill 三级
	const famGrp = familyOf(adapter?.key, srcFamilies);
	const famChannels = famGrp?.channels ?? [];
	const srcCh = channelOf(adapter?.key, famChannels);
	// 参数表单：第三方本地渠道（paramsFromMode）按第三方要求用 mode.paramsSchema；
	// 管理端模型优先用 **catalog 模型 params**（第131轮：要求档位按模型服务端控——gf903 四档分辨率 /
	// hn 时长三档等随 catalog 热更）；无则回退节点 spec 固定参数。
	const paramSchema: ParamField[] = ((adapter?.paramsFromMode
		? mode?.paramsSchema
		: (catModel?.params?.length ? catModel.params : (def.params && def.params.length ? def.params : mode?.paramsSchema))) as ParamField[]) ?? [];
	// 方法（第131轮）：catalog 模型 methods 声明多方法才显示方法 pill；残留值收敛到支持集
	const vMethods = modelMethods(catModel);
	const vMethod = clampMethod(params.method, vMethods);
	// 真人图（官方真人库模型 + 全能参考）：素材区图片（上游+自加合并序）0 基下标多选
	const imgItems = getNodeMaterialItems(nodeId).filter((it) => it.media === "image");
	const officialSel = new Set(((params.officialAssetIndexes as number[] | undefined) ?? []).filter((i) => i >= 0 && i < imgItems.length));

	// 家族下拉条目：每个家族一条（选中即进该家族——当前模型在家族内保持款式、否则取家族第一款）
	const dropdownOptions: { id: string; name: string; family: FamilyGroup }[] = srcFamilies.map((f) => ({
		id: modelForFamily(f.familyId, adapter?.key, srcFamilies),
		name: f.familyName,
		family: f,
	}));

	const onRun = () => {
		// 无可用模型（catalog 无该能力模型）：请求不发出，直接打开「设置 → 管理端」引导连接（零兜底，不落假值）。
		if (!adapter || !mode) {
			useUiStore.getState().openModelSettings();
			return;
		}
		// 关键修复：把模型参数（时长/比例/分辨率等）连同默认值一并落进节点 params 再运行，
		// 否则用户未手动展开二级面板时，请求只带 model+prompt，上游收不到这些参数。
		const patch: Record<string, unknown> = { model: adapter.key, mode: mode.key };
		for (const f of paramSchema) {
			if (params[f.key] === undefined && f.default !== undefined) patch[f.key] = f.default;
		}
		setParam(patch);
		dispatchCommand({ type: "run", nodeId });
	};

	// 组合参数显示文本（按 catalog 参数枚举/数值字段拼，值即上游所需值）
	const paramsSummary =
		paramSchema
			.filter((f) => f.type === "enum" || f.type === "number")
			.map((f) => {
				const v = params[f.key] ?? f.default;
				return v === undefined ? null : `${v}${f.unit ?? ""}`;
			})
			.filter(Boolean)
			.join("·") || "参数设置";

	// 视口坐标（订阅已上移到 early return 之前）
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

	// ── 处理类/只读结果节点（超分/去字幕/分段等）：面板锁定为信息展示（共享 ProcessInfoPanel） ──
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
				{/* 上列 80%：提示词 & 素材（输入）；底部留白压缩 */}
				<div className="flex flex-col px-5 pt-5 pb-2 flex-1 min-h-[140px] border-b border-white/5">
					{/* 素材区（可编辑）：上游连线素材(前) + 自加素材(后)，＋/拖入/粘贴添加；最右为提示词放大按钮 */}
					<NodeMaterialBay
						nodeId={nodeId}
						rightAction={<PromptExpandButton title="编辑视频提示词" getValue={() => prompt} onSave={(v) => setParam({ prompt: v })} placeholder="输入提示词…" getExtra={() => <NodeMaterialBay nodeId={nodeId} />} getMentions={() => getNodeMaterialItems(nodeId)} onImport={(cand) => importAssetToNode(nodeId, cand)} onMatchAssets={(draft) => matchNodeDraftAssets(nodeId, draft)} />}
					/>

					{/* 提示词输入区（自适应高度，超出内部滚动，不撑高面板）*/}
					<div className="min-w-0 relative mt-1">
						<NodePromptEditor nodeId={nodeId} prompt={prompt} onChange={(v) => setParam({ prompt: v })} placeholder={mode?.inputHint ?? "输入提示词生成视频..."} />
						
					</div>
				</div>

				{/* 下列 20%：可选功能区（py 压缩） */}
				<div className="flex items-center justify-between gap-3 px-5 py-2 shrink-0">
					<div className="flex items-center gap-2 min-w-0">
						{/* 模型选择（置于滚动容器外，避免下拉被 overflow 裁剪） */}
						<div className="relative shrink-0">
							<button
								onClick={(e) => {
									e.stopPropagation();
									setParamPanelExpanded(false);
									setActivePopoverKey(activePopoverKey === "model" ? null : "model");
								}}
								className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 text-foreground cursor-pointer whitespace-nowrap transition-colors ${activePopoverKey === "model" ? "bg-white/10 border-white/10" : "hover:bg-white/8"
									}`}
							>
								{famGrp ? famGrp.familyName : (adapter?.displayName ?? "选择模型")}
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
										{/* 家族列表：Seedance 2.0 / Sora2 / Grok… 各一条（渠道/线路与款式由旁边两个 pill 细选） */}
										{dropdownOptions.length === 0 && (
											<div className="px-3.5 py-2.5 text-xs text-muted-foreground">暂无可用模型（请在管理端配置）</div>
										)}
										{dropdownOptions.map((opt) => {
											const selected = famGrp?.familyId === opt.family.familyId;
											return (
												<button
													key={opt.family.familyId || "__other"}
													onClick={() => {
														// modelForFamily 已保证：当前模型在该家族内 → 保持不重置；否则取家族第一款
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
						</div>

						{/* 「渠道/线路」二级选择（家族 pill 旁）：家族内的源（模式名 / LibTV / 即梦） */}
						{famGrp && famChannels.length > 0 && (
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
															// 已在该线路 → 保持当前款式；否则取该线路默认款
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

						{/* 「模型」三级选择（线路 pill 旁）：线路内的具体款式（Seedance 2.0 / Fast / VIP…） */}
						{srcCh && (
							<div className="relative shrink-0">
								<button
									onClick={(e) => {
										e.stopPropagation();
										setParamPanelExpanded(false);
										setActivePopoverKey(activePopoverKey === "variant" ? null : "variant");
									}}
									className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 text-foreground cursor-pointer whitespace-nowrap transition-colors ${activePopoverKey === "variant" ? "bg-white/10 border-white/10" : "hover:bg-white/8"
										}`}
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

						{/* 方法 pill（第131轮）：模型声明多方法才显示（全能参考/首尾帧） */}
						{vMethods.length > 1 && (
							<div className="relative shrink-0">
								<button
									title="方法：全能参考=提示词+图/视频/音频参考；首尾帧=素材第 1 张图作首帧、第 2 张图作尾帧"
									onClick={(e) => {
										e.stopPropagation();
										setParamPanelExpanded(false);
										setActivePopoverKey(activePopoverKey === "method" ? null : "method");
									}}
									className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 text-foreground cursor-pointer whitespace-nowrap transition-colors ${activePopoverKey === "method" ? "bg-white/10 border-white/10" : "hover:bg-white/8"}`}
								>
									{METHOD_LABELS[vMethod]}
									<ChevronDown className="h-3 w-3 text-muted-foreground" />
								</button>
								<AnimatePresence>
									{activePopoverKey === "method" && (
										<motion.div
											data-dropdown
											initial={{ y: -8, opacity: 0 }}
											animate={{ y: 0, opacity: 1 }}
											exit={{ y: -8, opacity: 0 }}
											transition={panelTransition}
											style={{ position: "absolute", top: "100%", left: 0, marginTop: "6px", background: "rgba(22, 27, 38, 0.98)", border: "1px solid rgba(255, 255, 255, 0.12)", backdropFilter: "blur(20px)", boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)", zIndex: 1010 }}
											className="rounded-xl overflow-visible min-w-[170px] py-1"
											onClick={(e) => e.stopPropagation()}
										>
											{vMethods.map((k) => (
												<button
													key={k}
													onClick={() => { setParam({ method: k }); setActivePopoverKey(null); }}
													className={`flex items-center justify-between w-full px-3.5 py-2.5 text-xs transition-colors cursor-pointer text-left ${k === vMethod ? "bg-white/10 text-white font-medium" : "text-muted-foreground hover:bg-white/5 hover:text-foreground"}`}
												>
													<span className="flex-1 pr-2">{METHOD_LABELS[k]}{k === "frames" ? "（素材图1=首帧，图2=尾帧）" : ""}</span>
													{k === vMethod && <span className="text-green-400 text-[10px] ml-2">✓</span>}
												</button>
											))}
										</motion.div>
									)}
								</AnimatePresence>
							</div>
						)}

						{/* 真人图 pill（官方真人库模型 + 全能参考）：点选素材区第 N 张图为真人图像 → params.officialAssetIndexes */}
						{catModel?.officialAssets && vMethod === "omni" && imgItems.length > 0 && (
							<div className="relative shrink-0">
								<button
									title="真人图标记：选择哪些图片素材是真人图像（官方真人库注册用；默认不选）"
									onClick={(e) => {
										e.stopPropagation();
										setParamPanelExpanded(false);
										setActivePopoverKey(activePopoverKey === "official" ? null : "official");
									}}
									className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 text-foreground cursor-pointer whitespace-nowrap transition-colors ${activePopoverKey === "official" ? "bg-white/10 border-white/10" : "hover:bg-white/8"}`}
								>
									真人图{officialSel.size ? ` ${officialSel.size}` : ""}
									<ChevronDown className="h-3 w-3 text-muted-foreground" />
								</button>
								<AnimatePresence>
									{activePopoverKey === "official" && (
										<motion.div
											data-dropdown
											initial={{ y: -8, opacity: 0 }}
											animate={{ y: 0, opacity: 1 }}
											exit={{ y: -8, opacity: 0 }}
											transition={panelTransition}
											style={{ position: "absolute", top: "100%", left: 0, marginTop: "6px", background: "rgba(22, 27, 38, 0.98)", border: "1px solid rgba(255, 255, 255, 0.12)", backdropFilter: "blur(20px)", boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)", zIndex: 1010 }}
											className="rounded-xl overflow-visible min-w-[210px] py-1"
											onClick={(e) => e.stopPropagation()}
										>
											{imgItems.map((it, i) => {
												const on = officialSel.has(i);
												return (
													<button
														key={`${it.tag}-${i}`}
														onClick={() => {
															const next = new Set(officialSel);
															if (on) next.delete(i); else next.add(i);
															setParam({ officialAssetIndexes: [...next].sort((a, b) => a - b) });
														}}
														className={`flex items-center justify-between w-full px-3.5 py-2 text-xs transition-colors cursor-pointer text-left ${on ? "bg-white/10 text-white font-medium" : "text-muted-foreground hover:bg-white/5 hover:text-foreground"}`}
													>
														<span className="flex-1 pr-2 truncate">{it.tag} {it.name || `图片 ${i + 1}`}</span>
														{on && <span className="text-green-400 text-[10px] ml-2">✓</span>}
													</button>
												);
											})}
										</motion.div>
									)}
								</AnimatePresence>
							</div>
						)}

						{/* 参数汇总胶囊（二级面板对齐其下方展开） */}
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
									<VideoParamSecondary
										schema={paramSchema}
										params={params}
										setParam={setParam}
									/>
								)}
							</AnimatePresence>
						</div>

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
						<span
							className="flex items-center gap-1 text-xs text-muted-foreground font-semibold"
							title={`预计消耗积分（视频按时长计费${refVideoSeconds > 0 ? `，含参考视频 ${refVideoSeconds} 秒·不足1秒算1秒` : ""}）`}
						>
							{/* 悬浮图标=当前模型备注（第166轮）：管理端备注优先，未设默认显示参考素材上限 */}
							<span className="flex items-center cursor-help" title={modelNoteText(catModel) || undefined}>
								<Sparkles className="h-3.5 w-3.5 text-amber-400" />
							</span>
							<span>{creditEstimate ?? cost}</span>
						</span>
						<button
							onClick={onRun}
							disabled={running}
							className="h-8 w-8 rounded-full p-0 flex items-center justify-center cursor-pointer bg-white text-black hover:opacity-90 disabled:opacity-50 transition-all shadow-md active:scale-95"
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

/**
 * 视频参数二级面板：绝对定位锚在「参数汇总胶囊」正下方、左对齐其按钮、向下展开。
 * 完全由 catalog 下发的模型参数表单（mode.paramsSchema）驱动——枚举/数值/布尔自动渲染，
 * 选项值即上游所需值（如 480p/720p/1080p、16:9…），不再硬编码中文标签导致与上游枚举不匹配。
 */
function VideoParamSecondary({
	schema,
	params,
	setParam,
}: {
	schema: ParamField[];
	params: Record<string, unknown>;
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
			{schema.length === 0 && (
				<div className="text-[10px] text-muted-foreground">该模型暂无可调参数</div>
			)}
			{schema.map((f) => {
				const value = params[f.key] ?? f.default;

				if (f.type === "enum") {
					return (
						<div key={f.key}>
							<div className="text-[10px] text-muted-foreground mb-1">{f.label}</div>
							<div className="flex flex-wrap gap-1">
								{(f.options ?? []).map((opt) => (
									<button
										key={opt}
										onClick={() => setParam({ [f.key]: opt })}
										className={`px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all cursor-pointer ${value === opt
												? "bg-white text-black"
												: "bg-white/5 text-muted-foreground hover:bg-white/8 hover:text-foreground"
											}`}
									>
										{opt}
									</button>
								))}
							</div>
						</div>
					);
				}

				if (f.type === "number") {
					const min = f.min ?? 0;
					const max = f.max ?? 100;
					const step = f.step ?? 1;
					const num = Number(value ?? min);
					return (
						<div key={f.key}>
							<div className="text-[10px] text-muted-foreground mb-0.5">{f.label}</div>
							<div className="text-sm font-bold text-white mb-0.5">{num}{f.unit ?? ""}</div>
							<input
								type="range"
								min={min}
								max={max}
								step={step}
								value={num}
								onChange={(e) => setParam({ [f.key]: Number(e.target.value) })}
								className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
							/>
						</div>
					);
				}

				if (f.type === "boolean") {
					return (
						<label key={f.key} className="flex items-center justify-between cursor-pointer">
							<span className="text-[10px] text-muted-foreground">{f.label}</span>
							<input
								type="checkbox"
								checked={!!value}
								onChange={(e) => setParam({ [f.key]: e.target.checked })}
								className="accent-white cursor-pointer"
							/>
						</label>
					);
				}

				// text / textarea
				return (
					<div key={f.key}>
						<div className="text-[10px] text-muted-foreground mb-1">{f.label}</div>
						<input
							type="text"
							value={typeof value === "string" ? value : ""}
							onChange={(e) => setParam({ [f.key]: e.target.value })}
							className="w-full px-2 py-1 rounded-md text-[11px] bg-white/5 border border-white/10 text-foreground outline-none focus:border-white/20"
						/>
					</div>
				);
			})}
		</motion.div>
	);
}