/**
 * RtcCenterTabSwitch —— 中栏标题栏里的「AI 工作台 / 预览」紧凑页签（第240轮：从 RtcCenterStage
 * 顶部整行 nav 收进标题栏省一行竖向空间；经 FrameEditor 的 headerExtra 与分集切换器并排挂载）。
 * 读写 rtcCenterTabStore（自动切换信号 centerTabAutoSwitch 仍在 RtcCenterStage 里发，本组件只显示/手动切）。
 * ⚠ 标题栏整条可拖起换面板（RtcPanelFrame 第236轮）：内部控件 draggable={false} + mousedown 不冒泡
 *   （照 RtcEpisodeSwitcher 同款做法）。
 */
import { CENTER_TABS } from "./rtcCenterTabCore";
import { useRtcCenterTabStore } from "./rtcCenterTabStore";

export function RtcCenterTabSwitch() {
	const tab = useRtcCenterTabStore((s) => s.tab);
	return (
		<div
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
						title={t.id === "workbench" ? "AI 工作台：选中分镜/结果占位的生成工作台" : "预览：时间指针顺序预览 / 左栏素材预览"}
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
