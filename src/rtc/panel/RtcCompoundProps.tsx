/**
 * RtcCompoundProps —— 复合片段的属性视图（第四批，右栏「属性」页 kind:"compound" 分派到这里）。
 * 内容：名称（可改，写回片段与子文档）/ 子时间轴概览（轨道数/片段数/子时长）/
 * 「进入编辑」（= 双击片段同一入口 enterCompound）/ 「解除复合」（dissolveCompound，一次 undo）。
 * ⚠ 数据变更只走 rtcStore.commit（复合片段只存在于主层，这里不需要 commitActive）。
 */
import { CornerDownRight, Layers, Ungroup } from "lucide-react";
import type { RtcSegment, RtcTrack } from "@/types/rtc";
import { dissolveCompound, subDocDurationUs } from "@/lib/rtcCompound";
import { useRtcStore } from "@/store/rtcStore";

const US_PER_SEC = 1_000_000;

function fmtSec(us: number): string {
	return `${(us / US_PER_SEC).toFixed(1)}s`;
}

export function RtcCompoundProps({ seg, track }: { seg: RtcSegment; track: RtcTrack }) {
	const sub = useRtcStore((s) => (seg.subDocId ? s.doc?.subDocs?.[seg.subDocId] : undefined));
	if (!seg.subDocId || !sub) {
		// 载入清洗会把缺失引用降级为占位符，正常到不了这里——防御式兜底
		return <div className="p-4 text-xs text-white/50">复合片段的子时间轴数据缺失。</div>;
	}
	const segCount = sub.tracks.reduce((n, t) => n + t.segments.length, 0);
	const subDurUs = subDocDurationUs(sub);

	const enter = () => useRtcStore.getState().enterCompound(seg.subDocId!);
	const dissolve = () => {
		useRtcStore.getState().commit((d) => dissolveCompound(d, seg.id));
		useRtcStore.getState().setSelection([]);
	};
	const rename = (name: string) => {
		const next = name.trim();
		useRtcStore.getState().commit((d) => {
			const cur = d.subDocs?.[seg.subDocId!];
			if (!cur || (next === cur.name && next === (seg.name ?? ""))) return d;
			return {
				...d,
				// 名称同时写回片段与子文档（时间轴片段标题与面包屑同源显示）
				tracks: d.tracks.map((t) => ({
					...t,
					segments: t.segments.map((s) => (s.id === seg.id ? { ...s, name: next || undefined } : s)),
				})),
				subDocs: { ...d.subDocs, [seg.subDocId!]: { ...cur, name: next || cur.name } },
			};
		});
	};

	return (
		<div className="p-3 flex flex-col gap-3 text-xs text-white/75">
			<div className="flex items-center gap-2">
				<Layers size={14} className="text-[#a78bfa] shrink-0" />
				<span className="text-[13px] text-white/90">复合片段</span>
				<span className="ml-auto text-white/40">{track.name || "视频"}轨</span>
			</div>
			<label className="flex flex-col gap-1">
				<span className="text-white/45">名称</span>
				<input
					defaultValue={seg.name || sub.name}
					onBlur={(e) => rename(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
					className="h-7 px-2 rounded bg-white/5 border border-white/10 text-white/85 outline-none focus:border-[#a78bfa]"
				/>
			</label>
			<div className="grid grid-cols-3 gap-2 text-center">
				<div className="rounded bg-white/5 py-2">
					<div className="text-white/90 tabular-nums">{sub.tracks.length}</div>
					<div className="text-[10px] text-white/40 mt-0.5">子轨道</div>
				</div>
				<div className="rounded bg-white/5 py-2">
					<div className="text-white/90 tabular-nums">{segCount}</div>
					<div className="text-[10px] text-white/40 mt-0.5">子片段</div>
				</div>
				<div className="rounded bg-white/5 py-2">
					<div className="text-white/90 tabular-nums">{fmtSec(subDurUs)}</div>
					<div className="text-[10px] text-white/40 mt-0.5">子时长</div>
				</div>
			</div>
			<div className="text-[10px] leading-relaxed text-white/40">
				复合片段是一段子时间轴的引用：可像普通片段一样移动/裁剪/分割（分割的两半共享同一子时间轴）。
				子内容变长不会自动撑长本片段——尾部超出窗口的内容会被裁掉（与素材裁剪同语义）。
			</div>
			<div className="flex gap-2">
				<button
					type="button"
					onClick={enter}
					className="flex-1 h-8 rounded flex items-center justify-center gap-1 bg-[rgba(139,92,246,0.18)] border border-[rgba(139,92,246,0.5)] text-[#d6c8ff] hover:bg-[rgba(139,92,246,0.28)]"
					title="进入子时间轴编辑（双击时间轴上的复合片段同效）"
				>
					<CornerDownRight size={12} /> 进入编辑
				</button>
				<button
					type="button"
					onClick={dissolve}
					className="flex-1 h-8 rounded flex items-center justify-center gap-1 border border-white/15 text-white/70 hover:bg-white/10"
					title="解除复合：子时间轴片段按本片段起点平移回主时间轴（放不下时就近落到新轨道）"
				>
					<Ungroup size={12} /> 解除复合
				</button>
			</div>
		</div>
	);
}
