/**
 * rtcCenterTabStore —— 中栏双页签（AI 工作台 / 预览）的当前页签。
 * 会话级 UI 态，不持久化（与 rtcPropsTabStore 同范式）；初始页签按规则 4
 * （doc 有可播片段=预览，否则=AI 工作台）在 RtcCenterStage 挂载时经 initTab 定**一次**，
 * 之后 手动点页签（setTab）与 自动切换信号（centerTabAutoSwitch → setTab）共用同一入口。
 * 已知边界：会话内切换项目不重定初始页签（与 rtcPropsTabStore 同现状，从简）。
 */
import { create } from "zustand";
import type { RtcCenterTab } from "./rtcCenterTabCore";

interface RtcCenterTabState {
	tab: RtcCenterTab;
	/** 初始页签是否已定过（规则 4 只在首次挂载生效一次，之后 initTab 为 no-op） */
	inited: boolean;
	setTab: (tab: RtcCenterTab) => void;
	initTab: (tab: RtcCenterTab) => void;
}

export const useRtcCenterTabStore = create<RtcCenterTabState>((set, get) => ({
	tab: "workbench",
	inited: false,
	setTab: (tab) => set({ tab, inited: true }),
	initTab: (tab) => {
		if (!get().inited) set({ tab, inited: true });
	},
}));
