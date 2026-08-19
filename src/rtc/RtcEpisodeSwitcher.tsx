/**
 * RtcEpisodeSwitcher —— 实时剪辑中栏标题栏的「分集」控件（用户定稿）：
 *   - 左对齐分集下拉（参考画布 EpisodeSwitcher）：点行=switchRtcEpisode 切换该集时间轴
 *     （一个分集=一条独立时间轴，防素材/片段堆一条轴上卡顿）；行悬停 × 删除（末集保护 +
 *     confirmDialog，删除语义与画布一致：连同 本集分镜/该集画布/**该集时间轨** 一并移除）；
 *     底部「＋新建分集」（addEpisode，与画布「＋分集」同一实体）；
 *   - 当前分集名**可编辑**（失焦/回车提交 updateEpisode——分集是三模式共享实体，改名全局生效）；
 *   - 分集影响：素材导入打分集标记、时间轨按分集分档、导出剪映草稿名带分集名。
 *
 * ⚠ 挂在 RtcPanelFrame 可拖拽标题栏内：全部交互控件 draggable={false} + mousedown 不冒泡，
 *   防止点下拉/改名把整个面板拖起来。
 */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Plus, X } from "lucide-react";
import { useProjectStore, resolveEpisodeKey } from "@/store/projectStore";
import { confirmDialog } from "@/lib/confirmDialog";

/** 当前激活分集名的行内编辑框（值随分集切换/外部改名跟随；提交走 updateEpisode） */
function EpisodeNameInput({ epId, title }: { epId: string; title: string }) {
	const [draft, setDraft] = useState(title);
	useEffect(() => setDraft(title), [epId, title]);
	const commit = () => {
		const v = draft.trim();
		if (!v || v === title) {
			setDraft(title); // 空/未变：还原不提交
			return;
		}
		useProjectStore.getState().updateEpisode(epId, { title: v });
	};
	return (
		<input
			value={draft}
			draggable={false}
			onMouseDown={(e) => e.stopPropagation()}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") (e.target as HTMLInputElement).blur();
				if (e.key === "Escape") {
					setDraft(title);
					(e.target as HTMLInputElement).blur();
				}
			}}
			title="当前分集命名（回车/失焦保存；分集与表格/画布模式共用，改名全局生效）"
			className="h-5 w-[150px] rounded border border-white/10 bg-white/5 px-1.5 text-[11px] text-white/85 outline-none focus:border-[var(--primary)]"
		/>
	);
}

export function RtcEpisodeSwitcher() {
	const episodes = useProjectStore((s) => s.episodes);
	const rtcEpisodeId = useProjectStore((s) => s.rtcEpisodeId);
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	// 点击下拉外 / Esc 关闭（与画布 EpisodeSwitcher 同款）
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	if (episodes.length === 0) return null;
	const activeId = resolveEpisodeKey(rtcEpisodeId, episodes);
	const active = episodes.find((e) => e.id === activeId) ?? episodes[0];

	const onDelete = async (ep: { id: string; title: string }) => {
		if (episodes.length <= 1) {
			alert("至少保留一集，无法删除最后一个分集。");
			return;
		}
		if (!(await confirmDialog(`删除分集「${ep.title}」？将一并移除本集全部分镜、该集画布与该集时间轨，操作不可撤销。`))) return;
		useProjectStore.getState().deleteEpisode(ep.id);
	};

	return (
		<div
			ref={wrapRef}
			className="relative flex items-center gap-1.5 min-w-0"
			draggable={false}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<button
				type="button"
				draggable={false}
				onClick={() => setOpen((v) => !v)}
				title="切换分集（每个分集是一条独立时间轨；素材导入与导出草稿名随分集）"
				className="flex h-5 max-w-[150px] items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 text-[11px] text-white/80 outline-none cursor-pointer hover:border-[var(--primary)] transition-colors"
			>
				<span className="truncate">{active?.title}</span>
				<ChevronDown className="h-3 w-3 shrink-0 text-white/40" />
			</button>
			{/* 当前分集命名（可编辑） */}
			<EpisodeNameInput epId={activeId} title={active?.title ?? ""} />
			{open && (
				<div className="absolute left-0 top-full z-[10160] mt-1 max-h-[50vh] w-max min-w-[150px] max-w-[240px] overflow-y-auto rounded-lg border border-white/12 bg-[#181a22] py-1 shadow-lg">
					{episodes.map((ep) => (
						<div
							key={ep.id}
							onClick={() => {
								useProjectStore.getState().switchRtcEpisode(ep.id);
								setOpen(false);
							}}
							className={`group flex cursor-pointer items-center gap-1 px-2 py-1 text-[11px] hover:bg-white/8 ${
								ep.id === activeId ? "text-[var(--primary)] font-medium" : "text-white/80"
							}`}
						>
							<span className="flex-1 truncate">{ep.title}</span>
							{episodes.length > 1 && (
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										void onDelete(ep);
									}}
									title={`删除分集「${ep.title}」（连同本集分镜、该集画布与该集时间轨，不可撤销）`}
									className="shrink-0 rounded p-0.5 text-white/35 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
								>
									<X className="h-3 w-3" />
								</button>
							)}
						</div>
					))}
					<div
						onClick={() => {
							const id = useProjectStore.getState().addEpisode();
							useProjectStore.getState().switchRtcEpisode(id);
							setOpen(false);
						}}
						className="flex cursor-pointer items-center gap-1 border-t border-white/8 px-2 py-1 text-[11px] text-white/55 hover:bg-white/8 hover:text-white/85"
						title="新建分集（同时出现在表格/画布模式的分集列表；新集是一条空时间轨）"
					>
						<Plus className="h-3 w-3" /> 新建分集
					</div>
				</div>
			)}
		</div>
	);
}
