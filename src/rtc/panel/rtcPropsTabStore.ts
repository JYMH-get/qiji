/**
 * rtcPropsTabStore —— 右栏单一窗口的当前页签（属性/剧本/分镜）。
 * 会话级 UI 态：默认「属性」，不持久化（用户定「从简」）。
 * 「新的选中动作自动切回属性」的判定在 RtcPropertyPanel（shouldAutoSwitchToProps 纯函数）。
 */
import { create } from "zustand";
import type { RtcPropsTab } from "./rtcPropsTabCore";

interface RtcPropsTabState {
	tab: RtcPropsTab;
	setTab: (tab: RtcPropsTab) => void;
}

export const useRtcPropsTabStore = create<RtcPropsTabState>((set) => ({
	tab: "props",
	setTab: (tab) => set({ tab }),
}));
