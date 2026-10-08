/**
 * RtcCenterTabSwitch —— 中栏标题栏里的「总览 / AI 工作台 / 预览」紧凑页签（第240轮：从 RtcCenterStage
 * 顶部整行 nav 收进标题栏省一行竖向空间；经 FrameEditor 的 headerExtra 与分集切换器并排挂载）。
 * 页签按钮、时间轴快捷键与明确导航入口共用 rtcCenterTabStore；时间轴直接点击片段打开 AI 工作台。
 * 移动播放头和生成完成不自动切页；选中预览后，占位符和空隙也始终显示预览。
 * 切页只隐藏已打开的剧本编辑面，保留草稿供再次打开。
 * ⚠ 标题栏整条可拖起换面板（RtcPanelFrame 第236轮）：内部控件 draggable={false} + mousedown 不冒泡
 *   （照 RtcEpisodeSwitcher 同款做法）。
 */
import { CENTER_TABS } from "./rtcCenterTabCore";
import { useRtcCenterTabStore } from "./rtcCenterTabStore";

export function RtcCenterTabSwitch() {
	const tab = useRtcCenterTabStore((s) => s.tab);
	return (
		<div
			role="group" aria-label="中央页面"
			draggable={false}
			onMouseDown={(e) => e.stopPropagation()}
			className="flex h-5 shrink-0 items-center gap-px rounded border border-white/10 bg-white/5 p-px select-none"
		>
			{CENTER_TABS.map((t) => {
				const active = t.id === tab;
				return (
					<button
						key={t.id}
						type="button"
						draggable={false}
						onClick={() => useRtcCenterTabStore.getState().setTab(t.id)}
						aria-pressed={active}
						title={t.id === "overview" ? "总览：本集原文与分镜表格" : t.id === "workbench" ? "AI 工作台：选中分镜/结果占位的生成工作台" : "预览：时间指针顺序预览 / 资产图片与生成历史"}
						className={`h-full rounded-[3px] px-1.5 text-[10.5px] leading-none transition-colors cursor-pointer ${
							active ? "bg-[#a78bfa]/25 text-[#d6c8ff]" : "text-white/50 hover:text-white/85 hover:bg-white/10"
						}`}
					>
						{t.label}
					</button>
				);
			})}
		</div>
	);
}
