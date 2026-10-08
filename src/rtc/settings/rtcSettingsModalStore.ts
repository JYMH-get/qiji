/**
 * rtcSettingsModalStore —— 「实时剪辑设置」的开关态（会话级，不持久化）。
 * 两个入口共用：工具条「快捷键/设置」按钮（默认落「快捷键」页签）与播放器控制条「设置」按钮
 * （默认落「预览」页签）。generation 使用工具栏上拉菜单，其余页使用 RtcSettingsModal；
 * 共用状态保证同一时间只打开一处设置。
 */
import { create } from "zustand";

export type RtcSettingsTab = "keys" | "edit" | "preview" | "generation";

interface RtcSettingsModalState {
	open: boolean;
	tab: RtcSettingsTab;
	openModal: (tab?: RtcSettingsTab) => void;
	setTab: (tab: RtcSettingsTab) => void;
	close: () => void;
}

export const useRtcSettingsModal = create<RtcSettingsModalState>((set) => ({
	open: false,
	tab: "keys",
	openModal: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab })),
	setTab: (tab) => set({ tab }),
	close: () => set({ open: false }),
}));
