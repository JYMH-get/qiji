/**
 * viewAngleStore —— 「转视角」多角度编辑器的全局会话态（弹窗在 App 根挂一次，任意界面可唤起）。
 * 三个入口共用：图片节点悬停「转视角」/ 右键「转视角…」/ 灯箱「转视角」。
 */
import { create } from "zustand";

export interface ViewAngleSession {
	/**
	 * 源图二选一：nodeId=画布图片节点（产物节点连线承接源图）；
	 * uri/assetId=灯箱等无节点场景（产物节点自带素材，落视口中心）。
	 */
	source: { nodeId?: string; uri?: string; assetId?: string; name?: string };
	/** 预览显示源（取景器画面） */
	previewUri: string;
	/** 预览兜底源（服务端 /raw 直读；主源取字节失败时试它——公网 OSS url 在部分环境不可 fetch） */
	previewFallbackUri?: string;
}

interface ViewAngleState {
	session: ViewAngleSession | null;
	open: (session: ViewAngleSession) => void;
	close: () => void;
}

export const useViewAngleStore = create<ViewAngleState>((set) => ({
	session: null,
	open: (session) => set({ session }),
	close: () => set({ session: null }),
}));

export const openViewAngle = (session: ViewAngleSession) => useViewAngleStore.getState().open(session);
