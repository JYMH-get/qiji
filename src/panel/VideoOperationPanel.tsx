import { useState, useMemo, useEffect } from "react";
import type { CSSProperties } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Play, Sparkles, ChevronDown, ChevronRight, AtSign } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { getAdapter, listAdaptersForNodeType } from "@/services/modelAdapter";
import { getPlugin } from "@/nodes/pluginRegistry";
import { dispatchCommand } from "@/command/dispatch";
import { PromptComposer } from "./PromptComposer";
import { getChannelModelsForNodeType, resolveActiveModelKey } from "@/services/adapters/channelAdapter";
import { useLibraryStore } from "@/store/libraryStore";
import { getMentionSuggestions } from "@/lib/mentionResolver";

const panelTransition = { duration: 0.18 };

/**
 * 视频节点专用操作面板
 * 匹配截图设计：顶部 tabs + 中间大文本区 + 底部参数胶囊行
 */
export function VideoOperationPanel({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const runtime = useCanvasStore((s) => s.runtime[nodeId]);


	const [activePopoverKey, setActivePopoverKey] = useState<string | null>(null);
	const [hoveredModelKey, setHoveredModelKey] = useState<string | null>(null);
	const [paramPanelExpanded, setParamPanelExpanded] = useState(false);
	const [mentionMenu, setMentionMenu] = useState<{ anchorEl: HTMLElement; x: number; y: number } | null>(null);

	useEffect(() => {
		const handleDocumentClick = () => {
			setActivePopoverKey(null);
			setParamPanelExpanded(false);
			setHoveredModelKey(null);
			setMentionMenu(null);
		};
		document.addEventListener("click", handleDocumentClick);
		return () => {
			document.removeEventListener("click", handleDocumentClick);
		};
	}, []);

	const channelModelOptions = useMemo(() => getChannelModelsForNodeType(node?.type ?? "video"), [node]);

	const view = useMemo(() => {
		if (!node) return null;
		const def = getPlugin(node.type);
		if (!def) return null;
		const adapters = listAdaptersForNodeType(node.type);
		const params = node.data.params;
		const modelKey = resolveActiveModelKey(node.type, params.model, def.defaultModel);
		let adapter = getAdapter(modelKey);
		if (!adapter) {
			adapter = adapters[0];
		}
		if (!adapter) {
			adapter = {
				key: modelKey || `${node.type}-model`,
				displayName: def.defaultModel || `${def.label}模型`,
				vendor: "内置",
				nodeTypes: [node.type],
				baseCost: 10,
				modes: [{ key: "default", label: "默认模式", inputHint: "输入提示词...", paramsSchema: [] }],
				estimateCost: () => 10,
				submit: async () => ({ taskId: `task-fallback-${Date.now()}` }),
				poll: async () => ({ status: "success", progress: 100 }),
			} as any;
		}
		const activeAdapter = adapter!;
		const modeKey =
			typeof params.mode === "string" &&
			activeAdapter.modes.some((m) => m.key === params.mode)
				? (params.mode as string)
				: activeAdapter.modes[0].key;
		const mode = activeAdapter.modes.find((m) => m.key === modeKey) ?? activeAdapter.modes[0];
		const cost = activeAdapter.estimateCost(mode.key, params);
		return { def, adapters, params, adapter: activeAdapter, modeKey, mode, cost };
	}, [node, channelModelOptions]);

	const prompt = typeof (node?.data?.params?.prompt) === "string" ? node.data.params.prompt : "";

	if (!node || !view) return null;
	const { def, params, adapter, modeKey, mode, cost } = view;
	const running = runtime?.status === "running" || runtime?.status === "queued";

	const setParam = (patch: Record<string, unknown>) =>
		dispatchCommand({ type: "updateNodeParams", id: nodeId, params: patch });

	const onRun = () => {
		setParam({ model: adapter.key, mode: mode.key });
		dispatchCommand({ type: "run", nodeId });
	};



	// 组合参数显示文本
	const resolution = typeof params.resolution === "string" ? params.resolution : "480p";
	const aspectRatio = typeof params.aspect_ratio === "string" ? params.aspect_ratio : "横屏（16:9）";
	const duration = typeof params.duration === "number" ? params.duration : 4;
	const paramsSummary = `${resolution} · ${aspectRatio} · ${duration}s`;

	const nodes = useCanvasStore((s) => s.nodes);
	const edges = useCanvasStore((s) => s.edges);
	const assets = useLibraryStore((s) => s.assets);

	const mediaInputs = useMemo(() => {
		if (!node) return [];
		const def = getPlugin(node.type);
		if (!def) return [];
		return def.inputs.filter((input) => input.name !== "text" && !input.formats.includes("text"));
	}, [node]);

	const connectedMediaItems = useMemo(() => {
		const items: { portName: string; upstreamNodeId: string; asset: any }[] = [];
		for (const input of mediaInputs) {
			const incoming = Object.values(edges).filter(
				(edge) => edge.target === nodeId && edge.targetPort === input.name
			);
			for (const edge of incoming) {
				const upstreamNode = nodes[edge.source];
				const assetId = upstreamNode?.data?.resultAssetId;
				const asset = assetId ? assets[assetId] : null;
				items.push({
					portName: input.name,
					upstreamNodeId: edge.source,
					asset,
				});
			}
		}
		return items;
	}, [nodeId, mediaInputs, nodes, edges, assets]);

	const hasUnconnectedMedia = useMemo(() => {
		for (const input of mediaInputs) {
			const hasIncoming = Object.values(edges).some(
				(edge) => edge.target === nodeId && edge.targetPort === input.name
			);
			if (!hasIncoming) {
				return true;
			}
		}
		return false;
	}, [nodeId, mediaInputs, edges]);

	const mentionSuggestions = useMemo(() => {
		const suggestions = getMentionSuggestions(nodeId);
		return suggestions.filter((s) => s.upstreamNodeId !== null);
	}, [nodeId, nodes, edges]);

	const insertMention = (portName: string) => {
		const newPrompt = prompt + ` @[${portName}] `;
		setParam({ prompt: newPrompt });
		setMentionMenu(null);
	};

	const handlePromptKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "@" && mentionSuggestions.length > 0) {
			const el = e.currentTarget;
			const rect = el.getBoundingClientRect();
			setMentionMenu({ anchorEl: el, x: 16, y: rect.height });
		}
		if (mentionMenu && e.key === "Escape") {
			setMentionMenu(null);
		}
	};

	// 视口坐标
	const viewport = useCanvasStore((s) => s.viewport);
	const zoom = viewport.zoom;
	const nodeCenterX = node.x * zoom + viewport.x + (node.w / 2) * zoom;
	const nodeBottomY = (node.y + node.h) * zoom + viewport.y;

	const wrapperStyle: CSSProperties = {
		position: "absolute",
		left: `${nodeCenterX}px`,
		top: `${nodeBottomY + 8}px`,
		transform: "translate(-50%, 0)",
		zIndex: 10001,
	};

	const resolutionOptions = ["480p", "720p（标清）", "1080p（高清）"];
	const aspectRatioOptions = ["横屏（16:9）", "竖屏（9:16）", "方形（1:1）", "21:9", "3:4", "4:3"];

	return (
		<div
			style={wrapperStyle}
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
				className="w-[680px] rounded-2xl text-foreground flex flex-col overflow-visible"
			>
				{/* 上列 80%：提示词 & 上游输出 */}
				<div className="flex flex-col p-5 flex-1 min-h-[140px] border-b border-white/5">
					{/* 上游输出预览卡 */}
					{(connectedMediaItems.length > 0 || hasUnconnectedMedia) && (
						<div className="flex flex-row gap-2 mb-3 shrink-0 flex-wrap">
							{connectedMediaItems.map((item, idx) => (
								<div
									key={`${item.upstreamNodeId}-${item.portName}-${idx}`}
									className="relative group w-11 h-11 rounded-xl border border-dashed border-white/10 hover:border-white/20 bg-white/3 flex flex-col items-center justify-center overflow-hidden transition-all"
									title={`上游输入: [${item.portName}]`}
								>
									{item.asset ? (
										<div className="relative w-full h-full">
											{item.asset.kind === "image" && (
												<img src={item.asset.uri} className="w-full h-full object-cover" />
											)}
											{item.asset.kind === "video" && (
												<video src={item.asset.uri} className="w-full h-full object-cover" />
											)}
											{item.asset.kind !== "image" && item.asset.kind !== "video" && (
												<div className="w-full h-full flex flex-col items-center justify-center p-1 bg-white/5">
													<span className="text-[10px] text-white/90 font-medium truncate max-w-full leading-tight select-none">
														{item.asset.name}
													</span>
												</div>
											)}
											<div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
												<span className="text-[8px] text-white/95 font-mono select-none">[{item.portName}]</span>
											</div>
										</div>
									) : (
										<div className="flex flex-col items-center justify-center text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer select-none">
											<span className="text-sm font-light leading-none">+</span>
											<span className="text-[8px] mt-0.5 font-mono leading-none">[{item.portName}]</span>
										</div>
									)}
								</div>
							))}
							{hasUnconnectedMedia && (
								<div className="w-11 h-11 rounded-xl border border-dashed border-white/10 bg-white/2 flex flex-col items-center justify-center text-muted-foreground/30 select-none">
									<span className="text-sm font-light leading-none">+</span>
									<span className="text-[8px] mt-0.5 leading-none">素材</span>
								</div>
							)}
						</div>
					)}

					{/* 提示词输入区 */}
					<div className="flex-1 min-w-0 h-full relative">
						<PromptComposer
							nodeId={nodeId}
							prompt={prompt}
							onChange={(value) => setParam({ prompt: value })}
							onKeyDown={handlePromptKeyDown}
							placeholder={mode.inputHint ?? "输入提示词生成视频..."}
							minHeight={100}
							maxHeight={140}
						/>
						{/* Mention suggestions */}
						<AnimatePresence>
							{mentionMenu && mentionSuggestions.length > 0 && (
								<motion.div
									initial={{ y: 6, opacity: 0 }}
									animate={{ y: 0, opacity: 1 }}
									exit={{ y: 6, opacity: 0 }}
									transition={panelTransition}
									style={{
										position: "absolute",
										left: "8px",
										top: "100%",
										marginTop: "4px",
										background: "rgba(22, 27, 38, 0.98)",
										border: "1px solid rgba(255, 255, 255, 0.12)",
										backdropFilter: "blur(20px)",
										boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
										zIndex: 1020,
									}}
									className="rounded-xl p-1.5 flex flex-col gap-0.5 min-w-[200px]"
									onClick={(e) => e.stopPropagation()}
								>
									<div className="px-2 py-1 text-[9px] text-muted-foreground font-semibold uppercase tracking-wider select-none">
										引用上游节点
									</div>
									{mentionSuggestions.map((s) => (
										<button
											key={s.portName}
											onClick={() => insertMention(s.portName)}
											className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs text-left text-foreground hover:bg-white/5 transition-colors cursor-pointer w-full"
										>
											<AtSign className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
											<span className="font-mono">[{s.portName}]</span>
											{s.upstreamLabel && (
												<span className="text-muted-foreground truncate">
													— {s.upstreamLabel}
												</span>
											)}
										</button>
									))}
								</motion.div>
							)}
						</AnimatePresence>
					</div>
				</div>

				{/* 下列 20%：可选功能区 */}
				<div className="flex items-center justify-between gap-3 px-5 py-3 shrink-0">
					<div className="flex items-center gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: "none" }}>
						{/* 模型选择 */}
						<div className="relative">
							<button
								onClick={(e) => {
									e.stopPropagation();
									setActivePopoverKey(activePopoverKey === "model" ? null : "model");
								}}
								className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 text-foreground cursor-pointer whitespace-nowrap transition-colors ${
									activePopoverKey === "model" ? "bg-white/10 border-white/10" : "hover:bg-white/8"
								}`}
							>
								{adapter.displayName}
								<ChevronDown className="h-3 w-3 text-muted-foreground" />
							</button>
							<AnimatePresence>
								{activePopoverKey === "model" && (
									<motion.div
										initial={{ y: 8, opacity: 0 }}
										animate={{ y: 0, opacity: 1 }}
										exit={{ y: 8, opacity: 0 }}
										transition={panelTransition}
										style={{
											position: "absolute",
											bottom: "100%",
											left: 0,
											marginBottom: "6px",
											background: "rgba(22, 27, 38, 0.98)",
											border: "1px solid rgba(255, 255, 255, 0.12)",
											backdropFilter: "blur(20px)",
											boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
											zIndex: 1010,
										}}
										className="rounded-xl overflow-visible min-w-[180px] py-1"
										onClick={(e) => e.stopPropagation()}
									>
										{/* 跟随默认选项 */}
										<div className="relative">
											<button
												onClick={() => {
													setParam({ model: "default" });
													setActivePopoverKey(null);
												}}
												className={`flex items-center justify-between w-full px-3.5 py-2.5 text-xs transition-colors cursor-pointer text-left ${
													!params.model || params.model === "default"
														? "bg-white/10 text-white font-medium"
														: "text-muted-foreground hover:bg-white/5 hover:text-foreground"
												}`}
											>
												<span className="flex-1 pr-2">跟随项目/全局默认</span>
												{(!params.model || params.model === "default") && (
													<span className="text-green-400 text-[10px] ml-2">✓</span>
												)}
											</button>
										</div>
										<div className="h-[1px] bg-white/5 my-0.5" />

										{channelModelOptions.map((opt) => {
											const optAdapter = getAdapter(opt.id);
											const optModes = optAdapter?.modes ?? [];
											return (
												<div
													key={opt.id}
													className="relative"
													onMouseEnter={() => setHoveredModelKey(opt.id)}
													onMouseLeave={() => setHoveredModelKey(null)}
												>
													<button
														className={`flex items-center justify-between w-full px-3.5 py-2.5 text-xs transition-colors cursor-pointer text-left ${
															opt.id === adapter.key
																? "bg-white/10 text-white"
																: "text-muted-foreground hover:bg-white/5 hover:text-foreground"
														}`}
													>
														<span className="flex-1 pr-2">
															{opt.modelName} <span className="text-muted-foreground text-[10px]">({opt.channelName})</span>
														</span>
														<ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
													</button>
													{hoveredModelKey === opt.id && optModes.length > 0 && (
														<div
															style={{
																position: "absolute",
																left: "100%",
																bottom: 0,
																marginLeft: "4px",
																background: "rgba(22, 27, 38, 0.98)",
																border: "1px solid rgba(255, 255, 255, 0.12)",
																backdropFilter: "blur(20px)",
																boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)",
																zIndex: 1020,
															}}
															className="rounded-xl overflow-hidden min-w-[140px] py-1"
														>
															{optModes.map((m) => (
																<button
																	key={m.key}
																	onClick={() => {
																		setParam({ model: opt.id, mode: m.key });
																		setActivePopoverKey(null);
																		setHoveredModelKey(null);
																	}}
																	className={`flex items-center justify-between w-full px-3.5 py-2 text-xs transition-colors cursor-pointer text-left ${
																		opt.id === adapter.key && m.key === modeKey
																			? "bg-white/10 text-white font-medium"
																			: "text-muted-foreground hover:bg-white/5 hover:text-foreground"
																	}`}
																>
																	<span>{m.label}</span>
																	{opt.id === adapter.key && m.key === modeKey && (
																		<span className="text-green-400 text-[10px] ml-2">✓</span>
																	)}
																</button>
															))}
														</div>
													)}
												</div>
											);
										})}
									</motion.div>
								)}
							</AnimatePresence>
						</div>

						{/* 参数汇总胶囊 */}
						<button
							onClick={(e) => {
								e.stopPropagation();
								setParamPanelExpanded(!paramPanelExpanded);
							}}
							className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer whitespace-nowrap ${
								paramPanelExpanded
									? "bg-white/15 border-white/20 text-white"
									: "bg-white/5 border-white/5 hover:bg-white/8 text-foreground"
							}`}
						>
							{paramsSummary}
							<ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${paramPanelExpanded ? "rotate-180" : ""}`} />
						</button>

						{/* 功能动作按钮 */}
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

					{/* 右侧：积分 + 运行按钮 */}
					<div className="flex items-center gap-2.5 shrink-0">
						<span className="flex items-center gap-1 text-xs text-muted-foreground font-semibold">
							<Sparkles className="h-3.5 w-3.5 text-amber-400" />
							<span>{cost}</span>
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

			{/* 二级面板 (直接在下方展开) */}
			<AnimatePresence>
				{paramPanelExpanded && (
					<motion.div
						initial={{ y: -8, opacity: 0 }}
						animate={{ y: 0, opacity: 1 }}
						exit={{ y: -8, opacity: 0 }}
						transition={panelTransition}
						style={{
							background: "rgba(22, 27, 38, 0.98)",
							border: "1px solid rgba(255, 255, 255, 0.1)",
							backdropFilter: "blur(20px)",
							boxShadow: "0 12px 32px rgba(0, 0, 0, 0.5)",
							width: "680px",
						}}
						className="rounded-xl p-4 text-foreground flex flex-col gap-4 mt-1.5"
						onClick={(e) => e.stopPropagation()}
					>
						{/* 时长 */}
						<div>
							<div className="text-[11px] text-muted-foreground mb-1">时长</div>
							<div className="text-lg font-bold text-white mb-1">{duration}s</div>
							<input
								type="range"
								min={4}
								max={15}
								step={1}
								value={Number(duration)}
								onChange={(e) => setParam({ duration: Number(e.target.value) })}
								className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-white"
							/>
							<div className="flex justify-between text-[8px] text-muted-foreground mt-1.5 px-0.5">
								{[4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((v) => (
									<span key={v} className={v === duration ? "text-white font-medium" : ""}>{v}s</span>
								))}
							</div>
						</div>

						{/* 分辨率 */}
						<div>
							<div className="text-[11px] text-muted-foreground mb-1.5">分辨率</div>
							<div className="flex gap-1.5">
								{resolutionOptions.map((opt) => (
									<button
										key={opt}
										onClick={() => setParam({ resolution: opt })}
										className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
											resolution === opt
												? "bg-white text-black"
												: "bg-white/5 text-muted-foreground hover:bg-white/8 hover:text-foreground"
										}`}
									>
										{opt}
									</button>
								))}
							</div>
						</div>

						{/* 宽高比 */}
						<div>
							<div className="text-[11px] text-muted-foreground mb-1.5">宽高比</div>
							<div className="flex flex-wrap gap-1.5">
								{aspectRatioOptions.map((opt) => (
									<button
										key={opt}
										onClick={() => setParam({ aspect_ratio: opt })}
										className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all cursor-pointer ${
											aspectRatio === opt
												? "bg-white text-black"
												: "bg-white/5 text-muted-foreground hover:bg-white/8 hover:text-foreground"
										}`}
									>
										{opt}
									</button>
								))}
							</div>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}