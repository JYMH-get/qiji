/**
 * rtcCenterTabStore —— 中栏三页签（总览 / AI 工作台 / 预览）与「剧本处理面」的会话状态。
 *
 * 会话级 UI 态，不持久化（与 rtcPropsTabStore 同范式）；初始页签在 RtcCenterStage 挂载时经
 * initTab 定一次；之后由用户点页签、快捷键或明确导航入口切换，移动播放头和生成完成不自动切页。
 *
 * `scriptEditorOpen` 表示剧本编辑会话已打开，`scriptEditorHidden` 控制其遮层是否暂时隐藏。
 * 切中央页签只隐藏编辑面，保留挂载与草稿；再次点「整理剧本」恢复显示，保存/取消/Esc 才关闭。
 * 状态集中在此，因为打开入口在右栏、编辑正文在中栏。
 * 已知边界：会话内切换项目不重定初始页签（与 rtcPropsTabStore 同现状，从简）。
 */
import { create } from "zustand";
import type { RtcCenterTab } from "./rtcCenterTabCore";

interface RtcCenterTabState {
	tab: RtcCenterTab;
	/** 初始页签是否已定过（只在首次挂载生效一次，之后 initTab 为 no-op） */
	inited: boolean;
	setTab: (tab: RtcCenterTab) => void;
	initTab: (tab: RtcCenterTab) => void;
	/** 剧本编辑会话是否打开；隐藏时仍挂载，保留未保存草稿。 */
	scriptEditorOpen: boolean;
	/** 切页只隐藏剧本面，保留未保存草稿；再次打开时恢复。 */
	scriptEditorHidden: boolean;
	setScriptEditorOpen: (open: boolean) => void;
}

export const useRtcCenterTabStore = create<RtcCenterTabState>((set, get) => ({
	tab: "workbench",
	inited: false,
	setTab: (tab) => set({ tab, inited: true, scriptEditorHidden: get().scriptEditorOpen }),
	initTab: (tab) => {
		if (!get().inited) set({ tab, inited: true });
	},
	scriptEditorOpen: false,
	scriptEditorHidden: false,
	setScriptEditorOpen: (scriptEditorOpen) => set({ scriptEditorOpen, scriptEditorHidden: false }),
}));

/** 右栏「整理剧本」入口：打开编辑面，或恢复隐藏中的草稿。 */
export function openRtcScriptEditor(): void {
	useRtcCenterTabStore.getState().setScriptEditorOpen(true);
}

/** 关闭剧本处理面（保存/取消/Esc 共用） */
export function closeRtcScriptEditor(): void {
	useRtcCenterTabStore.getState().setScriptEditorOpen(false);
}
