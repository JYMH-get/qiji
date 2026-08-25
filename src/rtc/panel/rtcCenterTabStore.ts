/**
 * rtcCenterTabStore —— 中栏双页签（AI 工作台 / 预览）的当前页签 + 「剧本处理面」的开合。
 *
 * 会话级 UI 态，不持久化（与 rtcPropsTabStore 同范式）；初始页签在 RtcCenterStage 挂载时经
 * initTab 定**一次**（播放头处有结果=预览，否则=AI 工作台），之后**只有用户手动点页签能换**
 * （第251轮需求⑨：自动切换整体废止，见 rtcCenterTabCore 头注释）。
 *
 * `scriptEditorOpen`（第251轮需求⑪）：右栏「剧本」页点「整理剧本」时，在**中栏**摊开剧本处理面
 * （最上层叠层）。放在这里而不是 RtcAiFlow 局部态的原因：开关在右栏、正文在中栏，跨组件；
 * 且右栏页签切走时不该把正在编辑的剧本面收掉。
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
	/** 中栏「剧本处理面」是否摊开（需求⑪；最上层叠层，用户手动关闭） */
	scriptEditorOpen: boolean;
	setScriptEditorOpen: (open: boolean) => void;
}

export const useRtcCenterTabStore = create<RtcCenterTabState>((set, get) => ({
	tab: "workbench",
	inited: false,
	setTab: (tab) => set({ tab, inited: true }),
	initTab: (tab) => {
		if (!get().inited) set({ tab, inited: true });
	},
	scriptEditorOpen: false,
	setScriptEditorOpen: (scriptEditorOpen) => set({ scriptEditorOpen }),
}));

/** 右栏「剧本」页的「整理剧本」按钮：在中栏摊开剧本处理面 */
export function openRtcScriptEditor(): void {
	useRtcCenterTabStore.getState().setScriptEditorOpen(true);
}

/** 关闭剧本处理面（保存/取消/Esc 共用） */
export function closeRtcScriptEditor(): void {
	useRtcCenterTabStore.getState().setScriptEditorOpen(false);
}
