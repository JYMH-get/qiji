import { useState, useMemo, useRef, useEffect } from "react";
import type { CSSProperties } from "react";
import { motion } from "motion/react";
import { Send, ChevronDown, ImagePlus, Loader2, X, RefreshCw, Lock } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { useCatalogStore } from "@/store/catalogStore";
import { getChannelModelsForNodeType, resolveActiveModelKey } from "@/services/adapters/channelAdapter";
import { dispatchCommand } from "@/command/dispatch";
import { managedClient } from "@/services/managedClient";
import { PromptExpandButton } from "@/components/PromptExpandButton";

const panelTransition = { duration: 0.18 };

/** 本地降采样缩略图（CSP 安全的 data: URL，用于展示上传图片） */
function fileToThumb(file: File, max = 512): Promise<string> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const url = URL.createObjectURL(file);
		img.onload = () => {
			const scale = Math.min(1, max / Math.max(img.width, img.height));
			const w = Math.max(1, Math.round(img.width * scale));
			const h = Math.max(1, Math.round(img.height * scale));
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			if (!ctx) { URL.revokeObjectURL(url); reject(new Error("no ctx")); return; }
			ctx.drawImage(img, 0, 0, w, h);
			URL.revokeObjectURL(url);
			resolve(canvas.toDataURL("image/webp", 0.82));
		};
		img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load fail")); };
		img.src = url;
	});
}

type PendingImg = { id?: string; url: string; previewUrl?: string; name?: string };

/**
 * AI对话节点的整合面板（单轮问答）：
 * - 提问编辑（首次答成后锁定，只能重新回答、不能改问）
 * - 模型选择 + 图片附加（仅未锁定时）
 * - 「跳过本轮」开关（跳过的节点其问答不计入下游记忆）
 * - 发送 / 重新回答（经 run 命令走 runChatNode：带上游记忆、答完自动新建下游对话节点）
 */
export function ChatPanel({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const viewport = useCanvasStore((s) => s.viewport);
	const status = useCanvasStore((s) => s.runtime[nodeId]?.status ?? "idle");
	const catalogVersion = useCatalogStore((s) => s.catalog?.version);

	const params = node?.data.params ?? {};
	const locked = !!params.questionLocked;
	const savedQuestion = String(params.question ?? params.prompt ?? "");

	const [input, setInput] = useState(savedQuestion);
	const [pending, setPending] = useState<PendingImg[]>([]);
	const [uploading, setUploading] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const composingRef = useRef(false);

	// 切换到不同节点 / 锁定状态变化时，同步输入框为该节点已存提问
	useEffect(() => {
		setInput(savedQuestion);
		setPending([]);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeId, locked]);

	useEffect(() => {
		const onDoc = () => setModelOpen(false);
		document.addEventListener("click", onDoc);
		return () => document.removeEventListener("click", onDoc);
	}, []);

	const modelOptions = useMemo(() => getChannelModelsForNodeType("ai.chat"), [catalogVersion]);
	const modelKey = resolveActiveModelKey("ai.chat", params.model);
	const modelLabel = modelOptions.find((m) => m.id === modelKey)?.modelName ?? (modelOptions.length ? "选择模型" : "无可用模型");

	if (!node) return null;

	const busy = status === "queued" || status === "running";
	const skipped = !!params.skipped;
	const setParam = (patch: Record<string, unknown>) => dispatchCommand({ type: "updateNodeParams", id: nodeId, params: patch });

	const onPickImages = () => {
		const fi = document.createElement("input");
		fi.type = "file";
		fi.accept = "image/*";
		fi.multiple = true;
		fi.onchange = async (e) => {
			const files = (e.target as HTMLInputElement).files;
			if (!files || !files.length) return;
			setUploading(true);
			try {
				for (const f of Array.from(files)) {
					if (!f.type.startsWith("image/")) continue;
					const previewUrl = await fileToThumb(f).catch(() => undefined);
					const res = await managedClient.uploadAsset(f, f.name || "chat.png", "TP");
					setPending((prev) => [...prev, { id: res.id, url: res.url, previewUrl, name: f.name }]);
				}
			} catch (err) {
				console.error("chat 图片上传失败", err);
			} finally {
				setUploading(false);
			}
		};
		fi.click();
	};

	// 发送：写入提问 + 图片，经 run 命令执行（runChatNode 带上游记忆）
	const onSend = () => {
		const text = input.trim();
		if ((!text && pending.length === 0) || busy || uploading) return;
		setParam({ question: text, images: pending.length ? pending : [], questionLocked: false });
		setPending([]);
		dispatchCommand({ type: "run", nodeId });
	};

	// 重新回答：用已锁定的提问重跑
	const onReanswer = () => {
		if (busy) return;
		dispatchCommand({ type: "run", nodeId });
	};

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

	return (
		<div
			style={wrapperStyle}
			data-node-panel
			className="pointer-events-auto flex flex-col items-center gap-2 w-fit"
			onClick={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.stopPropagation()}
			onPointerDown={(e) => e.stopPropagation()}
		>
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
				className="w-[520px] rounded-2xl text-foreground flex flex-col overflow-visible p-4 gap-2.5"
			>
				{/* 提问区 */}
				<div className="flex items-center justify-between">
					<span className="text-[10px] text-muted-foreground font-semibold">用户提问</span>
					{locked && (
						<span className="flex items-center gap-1 text-[10px] text-muted-foreground/80">
							<Lock className="h-3 w-3" /> 已锁定，只能重新回答
						</span>
					)}
				</div>

				{locked ? (
					<div className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-[13px] text-foreground/85 whitespace-pre-wrap break-words max-h-32 overflow-y-auto Qiji-scroll-thin">
						{savedQuestion || <span className="opacity-50">（无提问）</span>}
					</div>
				) : (
					<>
						{/* 待发图片 */}
						{pending.length > 0 && (
							<div className="flex flex-wrap gap-2">
								{pending.map((p, i) => (
									<div key={i} className="relative w-12 h-12 rounded-lg overflow-hidden border border-white/10">
										{p.previewUrl ? <img src={p.previewUrl} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-[8px] text-muted-foreground">{p.name}</div>}
										<button
											onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))}
											className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/70 flex items-center justify-center text-white"
										>
											<X className="w-2.5 h-2.5" />
										</button>
									</div>
								))}
							</div>
						)}
						<div className="relative">
							<textarea
								value={input}
								onChange={(e) => setInput(e.target.value)}
								onCompositionStart={() => (composingRef.current = true)}
								onCompositionEnd={() => (composingRef.current = false)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
										e.preventDefault();
										onSend();
									}
								}}
								placeholder="输入提问，Enter 发送（Shift+Enter 换行）"
								rows={2}
								className="w-full resize-none bg-white/5 border border-white/10 rounded-xl px-3 py-2 pr-8 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-white/20 Qiji-scroll-thin"
							/>
							<PromptExpandButton title="编辑提问" getValue={() => input} onSave={setInput} placeholder="输入提问…" style={{ position: "absolute", top: 6, right: 6 }} />
						</div>
					</>
				)}

				{/* 底部：模型 + 图片 / 跳过开关 + 发送/重新回答 */}
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2">
						<div className="relative">
							<button
								onClick={(e) => { e.stopPropagation(); setModelOpen((v) => !v); }}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white/5 border border-white/5 hover:bg-white/8 text-foreground cursor-pointer whitespace-nowrap"
							>
								{modelLabel}
								<ChevronDown className="h-3 w-3 text-muted-foreground" />
							</button>
							{modelOpen && (
								<div
									className="absolute bottom-full left-0 mb-2 min-w-[180px] max-h-60 overflow-y-auto Qiji-scroll-thin rounded-xl py-1 z-[1010]"
									style={{ background: "rgba(22,27,38,0.98)", border: "1px solid rgba(255,255,255,0.12)", boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}
									onClick={(e) => e.stopPropagation()}
								>
									{modelOptions.length === 0 && <div className="px-3.5 py-2 text-xs text-muted-foreground">无可用文本模型</div>}
									{modelOptions.map((opt) => (
										<button
											key={opt.id}
											onClick={() => { setParam({ model: opt.id }); setModelOpen(false); }}
											className={`flex items-center justify-between w-full px-3.5 py-2 text-xs text-left transition-colors cursor-pointer ${opt.id === modelKey ? "bg-white/10 text-white" : "text-muted-foreground hover:bg-white/5 hover:text-foreground"}`}
										>
											<span>{opt.modelName}</span>
											{opt.id === modelKey && <span className="text-green-400 text-[10px]">✓</span>}
										</button>
									))}
								</div>
							)}
						</div>
						{!locked && (
							<button
								onClick={onPickImages}
								disabled={uploading}
								title="附加图片"
								className="h-8 w-8 rounded-full flex items-center justify-center bg-white/5 border border-white/5 hover:bg-white/8 text-muted-foreground hover:text-foreground cursor-pointer disabled:opacity-50"
							>
								{uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
							</button>
						)}
						<label
							className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer select-none"
							title="跳过本轮：该节点的问答不计入下游对话记忆（上游与下游相连）"
						>
							<input type="checkbox" checked={skipped} onChange={(e) => setParam({ skipped: e.target.checked })} className="accent-[color:var(--node-chat)]" />
							跳过本轮
						</label>
					</div>
					{locked ? (
						<button
							onClick={onReanswer}
							disabled={busy}
							className="h-8 px-4 rounded-full flex items-center gap-1.5 cursor-pointer bg-white/8 border border-white/10 text-foreground text-xs font-semibold hover:bg-white/12 disabled:opacity-50"
						>
							{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
							重新回答
						</button>
					) : (
						<button
							onClick={onSend}
							disabled={busy || uploading}
							className="h-8 px-4 rounded-full flex items-center gap-1.5 cursor-pointer bg-[color:var(--node-accent)] text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50"
						>
							{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
							发送
						</button>
					)}
				</div>
			</motion.div>
		</div>
	);
}
