/**
 * panoStore —— 720°全景查看器的全局会话态（查看器在 App 根挂一次，任意界面可唤起）。
 */
import { create } from "zustand";

export interface PanoSession {
	/** 全景图显示源（取字节喂 WebGL 纹理） */
	uri: string;
	/** 取字节兜底源（服务端 /raw；主源 fetch 失败时试） */
	fallbackUri?: string;
	name?: string;
	/** 来源节点（截图产物落其右侧；空=视口中心） */
	sourceNodeId?: string;
}

interface PanoState {
	session: PanoSession | null;
	open: (session: PanoSession) => void;
	close: () => void;
}

export const usePanoStore = create<PanoState>((set) => ({
	session: null,
	open: (session) => set({ session }),
	close: () => set({ session: null }),
}));

export const openPanoViewer = (session: PanoSession) => usePanoStore.getState().open(session);
