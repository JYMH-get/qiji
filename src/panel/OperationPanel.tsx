import { useState, useMemo } from "react";
import type { CSSProperties } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Play, Sparkles, X, ChevronDown } from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ParamControl } from "./ParamControls";
import { useUiStore } from "@/store/uiStore";
import { useCanvasStore } from "@/store/canvasStore";
import { getAdapter, listAdaptersForNodeType } from "@/services/modelAdapter";
import { getPlugin } from "@/nodes/pluginRegistry";
import { dispatchCommand } from "@/command/dispatch";

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
	const setActiveNodeId = useUiStore((s) => s.setActiveNodeId);
	const { setNodes } = useReactFlow();

	const [showParams, setShowParams] = useState(false);

	const view = useMemo(() => {
		if (!node) return null;
		const def = getPlugin(node.type);
		if (!def) return null;
		const adapters = listAdaptersForNodeType(node.type);
		const params = node.data.params;
		const modelKey =
			typeof params.model === "string" ? params.model : def.defaultModel;
		const adapter = getAdapter(modelKey) ?? adapters[0];
		if (!adapter) return null;
		const modeKey =
			typeof params.mode === "string" &&
			adapter.modes.some((m) => m.key === params.mode)
				? (params.mode as string)
				: adapter.modes[0].key;
		const mode =
			adapter.modes.find((m) => m.key === modeKey) ?? adapter.modes[0];
		const cost = adapter.estimateCost(mode.key, params);
		return { def, adapters, params, adapter, modeKey, mode, cost };
	}, [node]);

	// 监听视口坐标以计算屏幕绝对位置
	const viewport = useCanvasStore((s) => s.viewport);

	if (!node || !view) return null;
	const { def, adapters, params, adapter, modeKey, mode, cost } = view;
	const Icon = def.icon;
	const prompt = typeof params.prompt === "string" ? params.prompt : "";
	const running = runtime?.status === "running" || runtime?.status === "queued";
	const accentStyle = { "--node-accent": def.accentVar } as CSSProperties;

	const setParam = (patch: Record<string, unknown>) =>
		dispatchCommand({ type: "updateNodeParams", id: nodeId, params: patch });

	const onModel = (key: string) => {
		const next = getAdapter(key);
		setParam({ model: key, mode: next?.modes[0]?.key });
	};
	const onRun = () => {
		setParam({ model: adapter.key, mode: mode.key });
		dispatchCommand({ type: "run", nodeId });
	};

	const onClose = (e?: React.MouseEvent) => {
		if (e) e.stopPropagation();
		setActiveNodeId(null);
		setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
	};

	// 动态计算该节点在屏幕视图空间下的中心底端坐标 (100% 抵御 zoom 缩放)
	const zoom = viewport.zoom;
	const nodeCenterX = node.x * zoom + viewport.x + (node.w / 2) * zoom;
	const nodeBottomY = (node.y + node.h) * zoom + viewport.y;

	const wrapperStyle: CSSProperties = {
		position: "absolute",
		left: `${nodeCenterX}px`,
		top: `${nodeBottomY + 8}px`,
		transform: "translate(-50%, 0)",
		zIndex: 1000,
	};

	// 胶囊汇总选中的参数摘要，如 16:9 · 720P · 5s
	const paramSummary = useMemo(() => {
		const parts: string[] = [];
		if (params.ratio) parts.push(String(params.ratio));
		if (params.resolution) parts.push(String(params.resolution));
		if (params.quality) parts.push(String(params.quality));
		if (params.duration) parts.push(String(params.duration));
		if (params.camera && params.camera !== "无") parts.push(String(params.camera));

		if (parts.length === 0 && mode.paramsSchema.length > 0) {
			mode.paramsSchema.slice(0, 2).forEach((f) => {
				const val = params[f.key] ?? f.default;
				if (val !== undefined && val !== null) {
					parts.push(`${f.label}: ${val}`);
				}
			});
		}
		return parts.join(" · ") || "调整参数";
	}, [params, mode]);

	return (
		<div
			style={wrapperStyle}
			className="pointer-events-auto flex flex-col items-center gap-1.5 w-[380px]"
			onClick={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.stopPropagation()}
			onPointerDown={(e) => e.stopPropagation()}
		>
			{/* ── 主操作面板 (精简化) ── */}
			<motion.div
				initial={{ y: 10, opacity: 0 }}
				animate={{ y: 0, opacity: 1 }}
				exit={{ y: 10, opacity: 0 }}
				transition={panelTransition}
				style={accentStyle}
				className="Qiji-panel w-full rounded-xl p-2.5 text-foreground shadow-2xl"
			>
				{/* 第一行：模型选择 & Modes 切换 */}
				<div className="flex items-center justify-between gap-1.5">
					<div className="flex items-center gap-1">
						<span
							className="flex h-5 w-5 items-center justify-center rounded-md"
							style={accentStyle}
						>
							<Icon className="h-3 w-3 text-[color:var(--node-accent)]" />
						</span>
						<Select value={adapter.key} onValueChange={onModel}>
							<SelectTrigger className="h-5.5 text-[10px] px-1.5 py-0 bg-secondary/40 border-none hover:bg-secondary/70 transition-colors w-24">
								<SelectValue />
							</SelectTrigger>
							<SelectContent className="bg-secondary/95 border-border/40">
								{adapters.map((a) => (
									<SelectItem key={a.key} value={a.key} className="text-[10px] py-1">
										{a.displayName}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{adapter.modes.length > 1 ? (
						<Tabs
							value={modeKey}
							onValueChange={(v) => setParam({ mode: v })}
							className="mx-1"
						>
							<TabsList className="h-5.5 p-0.5 bg-secondary/35 rounded-md gap-0.5">
								{adapter.modes.map((m) => (
									<TabsTrigger
										key={m.key}
										value={m.key}
										className="text-[9px] py-0.5 px-2 rounded-sm"
									>
										{m.label}
									</TabsTrigger>
								))}
							</TabsList>
						</Tabs>
					) : null}

					<button
						onClick={onClose}
						className="rounded p-0.5 text-muted-foreground hover:bg-secondary cursor-pointer shrink-0"
						aria-label="关闭"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				</div>

				{/* 第二行：提示词输入框 (精简高度) */}
				<textarea
					className="nodrag w-full bg-secondary/25 border border-border/25 rounded-lg p-2 text-[10px] leading-relaxed resize-none h-13 focus:outline-none focus:border-[color:var(--node-accent)]/55 transition-colors mt-2"
					placeholder={mode.inputHint ?? "输入提示词（可 @ 引用上游素材）…"}
					value={prompt}
					onChange={(e) => setParam({ prompt: e.target.value })}
				/>

				{/* 第三行：积分预估 & 胶囊参数汇总 & 运行按钮 */}
				<div className="flex items-center justify-between mt-2 pt-1 border-t border-border/15">
					<span className="flex items-center gap-0.5 text-[9px] text-muted-foreground font-medium">
						<Sparkles className="h-3 w-3 text-[color:var(--node-accent)]" />
						<span>{cost}积分</span>
					</span>

					{mode.paramsSchema.length > 0 ? (
						<button
							onClick={() => setShowParams(!showParams)}
							className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px] font-medium border border-border/25 bg-secondary/30 hover:bg-secondary/60 transition-all cursor-pointer ${
								showParams ? "border-[color:var(--node-accent)] text-[color:var(--node-accent)]" : "text-foreground"
							}`}
						>
							<span>{paramSummary}</span>
							<ChevronDown className={`h-2.5 w-2.5 transition-transform ${showParams ? "rotate-180" : ""}`} />
						</button>
					) : null}

					<div className="flex items-center gap-1">
						{def.actions?.map((act) => (
							<Button
								key={act.name}
								variant="outline"
								className="h-5.5 px-2 text-[9px] cursor-pointer border-[color:var(--node-accent)]/50 text-[color:var(--node-accent)] hover:bg-[color:var(--node-accent)] hover:text-white transition-colors"
								onClick={() => dispatchCommand({ type: "executeNodeAction", nodeId, actionName: act.name })}
								disabled={running}
							>
								{act.label}
							</Button>
						))}
						<button
							onClick={onRun}
							disabled={running}
							className="h-5.5 w-5.5 rounded-full p-0 flex items-center justify-center cursor-pointer bg-[color:var(--node-accent)] text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
							title="运行节点"
						>
							<Play className="h-2.5 w-2.5" fill="currentColor" />
						</button>
					</div>
				</div>
			</motion.div>

			{/* ── 下拉式二级参数调节面板 (精简字体，网格/滑块化) ── */}
			<AnimatePresence>
				{showParams && (
					<motion.div
						initial={{ y: -8, opacity: 0 }}
						animate={{ y: 0, opacity: 1 }}
						exit={{ y: -8, opacity: 0 }}
						transition={panelTransition}
						className="Qiji-panel w-full rounded-xl p-2.5 text-foreground shadow-xl border border-border/30"
					>
						{mode.paramsSchema.length ? (
							<div className="flex flex-col gap-2.5">
								{mode.paramsSchema.map((field) => (
									<div key={field.key} className="flex flex-col gap-1">
										<div className="flex items-center justify-between text-[9px] text-muted-foreground">
											<span className="font-medium">{field.label}</span>
											{field.type === "number" && (
												<span className="font-mono text-foreground">
													{String(params[field.key] ?? field.default)}
													{field.unit || ""}
												</span>
											)}
										</div>
										
										{field.type === "enum" ? (
											<div className="flex flex-wrap gap-1">
												{field.options?.map((opt) => (
													<button
														key={opt}
														onClick={() => setParam({ [field.key]: opt })}
														className={`px-2 py-0.5 rounded text-[9px] transition-colors cursor-pointer ${
															(params[field.key] ?? field.default) === opt
																? "bg-[color:var(--node-accent)] text-white font-semibold"
																: "bg-secondary/45 text-muted-foreground hover:text-foreground"
														}`}
													>
														{opt}
													</button>
												))}
											</div>
										) : field.type === "number" ? (
											<input
												type="range"
												min={field.min ?? 0}
												max={field.max ?? 100}
												step={field.step ?? 1}
												value={Number(params[field.key] ?? field.default)}
												onChange={(e) => setParam({ [field.key]: Number(e.target.value) })}
												className="w-full h-1 bg-secondary/45 rounded-lg appearance-none cursor-pointer accent-[color:var(--node-accent)]"
											/>
										) : (
											<ParamControl
												field={field}
												value={params[field.key]}
												onChange={(next) => setParam({ [field.key]: next })}
											/>
										)}
									</div>
								))}
							</div>
						) : (
							<div className="text-muted-foreground text-center py-2 text-[9px]">无调节参数</div>
						)}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
