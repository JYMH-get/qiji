/**
 * rtcSettingsModalStore —— 「实时剪辑设置」弹窗的开关态（会话级，不持久化）。
 * 两个入口共用：工具条「快捷键/设置」按钮（默认落「快捷键」页签）与播放器控制条「设置」按钮
 * （默认落「预览」页签）。弹窗本体见 RtcSettingsModal（由 RtcToolbar 常驻挂载）。
 */
import { create } from "zustand";

export type RtcSettingsTab = "keys" | "edit" | "preview";

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
