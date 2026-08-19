/**
 * RtcCompoundBreadcrumb —— 复合片段编辑上下文的面包屑条（第四批）。
 * 挂在 RtcTimeline 顶部：仅在正编辑子时间轴时出现，「主时间轴 › 复合片段N ×返回」。
 * 「主时间轴」与「×返回」都退出子层（exitCompound：选中/播放头各自重置）。
 */
import { ChevronRight, CornerUpLeft, Layers } from "lucide-react";
import { useRtcStore } from "@/store/rtcStore";

export function RtcCompoundBreadcrumb() {
	const editingSubDocId = useRtcStore((s) => s.editingSubDocId);
	const sub = useRtcStore((s) => (s.editingSubDocId ? s.doc?.subDocs?.[s.editingSubDocId] : undefined));
	if (!editingSubDocId || !sub) return null; // 子文档已不存在（解散/undo）= 视作已回主层
	const exit = () => useRtcStore.getState().exitCompound();
	return (
		<div className="shrink-0 flex items-center gap-1 h-7 px-2 text-[11px] border-b border-white/10 bg-[#191b23] select-none">
			<button
				type="button"
				onClick={exit}
				className="px-1.5 py-0.5 rounded text-white/60 hover:text-white/90 hover:bg-white/10"
				title="返回主时间轴"
			>
				主时间轴
			</button>
			<ChevronRight size={11} className="text-white/35 shrink-0" />
			<span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[rgba(139,92,246,0.16)] text-[#d6c8ff] max-w-[220px]">
				<Layers size={11} className="shrink-0" />
				<span className="truncate">{sub.name || "复合片段"}</span>
			</span>
			<span className="ml-2 text-white/35">正在编辑复合片段内部——改动只影响这个复合片段</span>
			<button
				type="button"
				onClick={exit}
				className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-white/15 text-white/70 hover:text-white hover:bg-white/10"
				title="退出复合片段编辑，返回主时间轴"
			>
				<CornerUpLeft size={11} /> 返回
			</button>
		</div>
	);
}
