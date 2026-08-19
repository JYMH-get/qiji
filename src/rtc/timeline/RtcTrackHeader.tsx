/**
 * 轨道头单元格：类型图标 + 名称（主轨带「主轨」徽标）+ 静音/锁定切换 + 删除轨道。
 * ⚠ 主轨（第一条 video 轨，见 rtcOps 主轨不变量）是画面基准——**不显示删除按钮**，
 *   服务端语义也由 rtcOps.removeTrack 兜底（删主轨 no-op）。
 *
 * 重命名：**双击名称**就地改（Enter/失焦提交、Esc 取消、留空=恢复默认名）。
 * 编辑中的 `<input>` 会被时间轴的全局快捷键守卫自动放行（shouldIgnoreKeyTarget 认 INPUT），
 * 空格/Delete 不会被时间轴劫持。
 */
import { memo, useEffect, useRef, useState } from "react";
import { Film, Lock, LockOpen, Music, Trash2, Type, Volume2, VolumeX } from "lucide-react";
import type { RtcTrack } from "@/types/rtc";
import { HEADER_W, ROW_H, TRACK_COLORS, TRACK_LABELS } from "./timelineUtil";

const TYPE_ICONS = { video: Film, audio: Music, text: Type } as const;

export const RtcTrackHeader = memo(function RtcTrackHeader({
	track,
	heightPx = ROW_H,
	isMain = false,
	onToggleMute,
	onToggleLock,
	onRemove,
	onRename,
}: {
	track: RtcTrack;
	/** 行高（文本轨半高时轨道头改单行紧凑布局；缺省=ROW_H 旧观感零变化） */
	heightPx?: number;
	/** 是否主轨（第一条视频轨）：显示徽标且不可删除 */
	isMain?: boolean;
	onToggleMute: (id: string) => void;
	onToggleLock: (id: string) => void;
	onRemove: (id: string) => void;
	/** 重命名（name 为空串=清除自定义名，回落默认「视频/音频/文本轨道」） */
	onRename: (id: string, name: string) => void;
}) {
	const Icon = TYPE_ICONS[track.type];
	const btn = "h-5 w-5 flex items-center justify-center rounded hover:bg-white/10";
	const defaultName = `${TRACK_LABELS[track.type]}轨道`;
	/** 紧凑（半高）布局：名称与按钮挤同一行（两行叠不进 32px） */
	const compact = heightPx < 48;

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(track.name ?? "");
	const inputRef = useRef<HTMLInputElement>(null);
	// 进入编辑：草稿取当前名（无自定义名则留空，placeholder 提示默认名）+ 自动聚焦全选
	useEffect(() => {
		if (!editing) return;
		setDraft(track.name ?? "");
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
		// 只在进入编辑那一刻取值，编辑中外部改名不覆盖用户正在敲的内容
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editing]);

	const submit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next !== (track.name ?? "")) onRename(track.id, next); // 未改动=不提交（不污染撤销栈）
	};

	return (
		<div
			data-hdr
			className={`group/hdr sticky left-0 z-20 shrink-0 flex px-2 bg-[#12141a] border-r border-b border-white/10 ${
				compact ? "flex-row items-center gap-1" : "flex-col justify-center gap-1"
			}`}
			style={{ width: HEADER_W, height: heightPx }}
		>
			<div className="flex items-center gap-1.5 min-w-0 flex-1">
				<Icon size={13} style={{ color: TRACK_COLORS[track.type] }} className="shrink-0" />
				{editing ? (
					<input
						ref={inputRef}
						value={draft}
						placeholder={defaultName}
						onChange={(e) => setDraft(e.target.value)}
						onBlur={submit}
						onKeyDown={(e) => {
							e.stopPropagation(); // 别让轨道名里的空格/Delete 冒到时间轴快捷键
							if (e.key === "Enter") submit();
							// Esc 放弃：先把草稿退回原名再退出编辑——即便退出时还触发一次提交也已是 no-op
							else if (e.key === "Escape") {
								setDraft(track.name ?? "");
								setEditing(false);
							}
						}}
						className="min-w-0 flex-1 h-5 px-1 rounded bg-white/10 border border-white/20 text-[11px] text-secondary-foreground outline-none"
					/>
				) : (
					<span
						className="text-[11px] text-secondary-foreground truncate cursor-text"
						title="双击重命名轨道"
						onDoubleClick={() => setEditing(true)}
					>
						{track.name || defaultName}
					</span>
				)}
				{isMain && !editing && (
					<span
						className="shrink-0 px-1 rounded-sm border text-[9px] leading-[13px]"
						style={{ borderColor: TRACK_COLORS.video, color: TRACK_COLORS.video }}
						title="主轨：预览画面以这条轨道为准，不可删除"
					>
						主轨
					</span>
				)}
			</div>
			<div className="flex items-center gap-0.5 shrink-0">
				{/* 紧凑布局（文本轨半高）：静音对文本无语义，省掉给名称让位 */}
				{!compact && (
					<button
						type="button"
						title={track.muted ? "取消静音" : "静音"}
						className={`${btn} ${track.muted ? "text-destructive" : "text-muted-foreground"}`}
						onClick={() => onToggleMute(track.id)}
					>
						{track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
					</button>
				)}
				<button
					type="button"
					title={track.locked ? "解锁轨道" : "锁定轨道"}
					className={`${btn} ${track.locked ? "text-[var(--node-file)]" : "text-muted-foreground"}`}
					onClick={() => onToggleLock(track.id)}
				>
					{track.locked ? <Lock size={12} /> : <LockOpen size={12} />}
				</button>
				{!isMain && (
					<button
						type="button"
						title="删除轨道（含其上全部片段，可撤销）"
						className={`${btn} ml-auto text-muted-foreground hover:text-destructive opacity-0 group-hover/hdr:opacity-100`}
						onClick={() => onRemove(track.id)}
					>
						<Trash2 size={12} />
					</button>
				)}
			</div>
		</div>
	);
});
