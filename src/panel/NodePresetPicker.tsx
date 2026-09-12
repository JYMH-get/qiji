import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";
import type { PresetScheme } from "@/lib/presetSchemes";

/** 图片、视频节点共用预设入口；面板负责与模型/参数下拉互斥。 */
export function NodePresetPicker({ schemes, open, onOpenChange, onSelect, onCreate }: {
	schemes: PresetScheme[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSelect: (id: string, name: string) => void;
	onCreate?: () => void;
}) {
	if (!schemes.length && !onCreate) return null;
	return (
		<div className="relative shrink-0">
			<button
				type="button"
				onMouseDown={(e) => e.preventDefault()}
				onClick={(e) => { e.stopPropagation(); onOpenChange(!open); }}
				aria-expanded={open}
				title="插入预设方案（提交时替换为完整预设词；双击胶囊可展开为正文）"
				className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold cursor-pointer whitespace-nowrap transition-colors"
				style={{ color: "#fcd34d", border: "1px solid rgba(245,158,11,0.4)", background: open ? "rgba(245,158,11,0.22)" : "rgba(245,158,11,0.12)" }}
			>
				▦ 预设方案
				<ChevronDown className="h-3 w-3" />
			</button>
			<AnimatePresence>
				{open && (
					<motion.div
						data-dropdown
						initial={{ y: -8, opacity: 0 }}
						animate={{ y: 0, opacity: 1 }}
						exit={{ y: -8, opacity: 0 }}
						transition={{ duration: 0.18 }}
						style={{
							position: "absolute", top: "100%", right: 0, marginTop: 6,
							background: "rgba(22, 27, 38, 0.98)",
							border: "1px solid rgba(255, 255, 255, 0.12)",
							boxShadow: "0 8px 32px rgba(0, 0, 0, 0.6)", zIndex: 1010,
						}}
						className="rounded-xl w-[288px] max-h-[300px] overflow-y-auto Qiji-scroll-thin py-1"
						onMouseDown={(e) => e.preventDefault()}
						onClick={(e) => e.stopPropagation()}
					>
						{schemes.length === 0 && <div className="px-3.5 py-2 text-xs text-muted-foreground">暂无视频预设</div>}
						{schemes.map((p) => (
							<button
								type="button"
								key={p.id}
								onClick={() => { onSelect(p.id, p.name); onOpenChange(false); }}
								className="block w-full text-left px-3.5 py-2 hover:bg-white/5 cursor-pointer"
							>
								<div className="text-xs font-semibold" style={{ color: "#fcd34d" }}>▦ {p.name}</div>
								<div className="text-[10px] text-muted-foreground mt-0.5" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{p.body}</div>
							</button>
						))}
						{onCreate && <button type="button" onClick={onCreate} className="block w-full text-left px-3.5 py-2 text-xs text-amber-300 hover:bg-white/5 cursor-pointer">＋ 添加视频预设</button>}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
