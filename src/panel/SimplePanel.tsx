import type { CSSProperties } from "react";
import { motion } from "motion/react";
import { Upload, FileText } from "lucide-react";
import { useCanvasStore } from "@/store/canvasStore";
import { getPlugin } from "@/nodes/pluginRegistry";
import { pickFileToUploadNode } from "@/canvas/nodeUpload";
import { PromptExpandButton } from "@/components/PromptExpandButton";

const panelTransition = { duration: 0.18 };

/** 文本种子 / 上传节点的轻面板：种子=文本编辑器；上传=（重新）选择文件 */
export function SimplePanel({ nodeId }: { nodeId: string }) {
	const node = useCanvasStore((s) => s.nodes[nodeId]);
	const viewport = useCanvasStore((s) => s.viewport);
	if (!node) return null;

	const plugin = getPlugin(node.type);
	const isUpload = plugin?.nodeKind === "upload";
	const prompt = typeof node.data.params.prompt === "string" ? (node.data.params.prompt as string) : "";

	// 种子文本：同时写 params.prompt 与 resultText（显示 + 下游引用一致）
	const setSeedText = (value: string) => {
		const cs = useCanvasStore.getState();
		const n = cs.nodes[nodeId];
		if (!n) return;
		useCanvasStore.setState({
			nodes: { ...cs.nodes, [nodeId]: { ...n, data: { ...n.data, params: { ...n.data.params, prompt: value }, resultText: value } } },
		});
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
				className="w-[460px] rounded-2xl text-foreground flex flex-col overflow-visible p-4 gap-2"
			>
				{isUpload ? (
					<>
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<FileText className="h-3.5 w-3.5" />
							<span className="truncate">{node.data.fileName || (node.data.resultAssetId ? "已载入素材" : "未选择文件")}</span>
						</div>
						<button
							onClick={() => pickFileToUploadNode(nodeId)}
							className="flex items-center justify-center gap-2 h-9 rounded-xl bg-[color:var(--node-accent)] text-white text-sm font-semibold hover:opacity-90 cursor-pointer"
						>
							<Upload className="h-4 w-4" />
							{node.data.resultAssetId ? "重新上传本地文件" : "上传本地文件"}
						</button>
					</>
				) : (
					<>
						<div className="flex items-center justify-between">
							<div className="text-[10px] text-muted-foreground font-semibold">文本内容</div>
							<PromptExpandButton title="编辑文本内容" getValue={() => prompt} onSave={setSeedText} placeholder="输入文本…" />
						</div>
						<textarea
							value={prompt}
							onChange={(e) => setSeedText(e.target.value)}
							placeholder="输入文本（作为下游节点的输入）…"
							rows={5}
							className="w-full resize-none bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-white/20 Qiji-scroll-thin"
						/>
					</>
				)}
			</motion.div>
		</div>
	);
}
