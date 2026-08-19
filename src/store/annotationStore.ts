/**
 * annotationStore —— 图片标注编辑器的全局会话态（编辑器在 App 根挂一次，任意界面可唤起）。
 * 三个入口共用：灯箱「标注」/ 图片节点悬停「标注」/ 图片节点右键「标注…」。
 */
import { create } from "zustand";
import type { AnnotationDoc } from "@/lib/annotation";

export interface AnnotationSession {
	/** 被标注的原图：uri=取字节用的显示源；assetId=台账 id（有则记进产物供再编辑溯源） */
	source: { uri: string; assetId?: string; name?: string };
	/** 再编辑时带入的既有矢量（新标注为空） */
	doc?: AnnotationDoc;
	/** 再编辑：完成后把结果写回该节点（旧主图进堆叠历史）；空=新建图片节点承载 */
	targetNodeId?: string;
	/** 新建节点的落点（画布坐标，通常=源节点右侧）；空=当前视口中心 */
	anchor?: { x: number; y: number };
}

interface AnnotationState {
	session: AnnotationSession | null;
	open: (session: AnnotationSession) => void;
	close: () => void;
}

export const useAnnotationStore = create<AnnotationState>((set) => ({
	session: null,
	open: (session) => set({ session }),
	close: () => set({ session: null }),
}));

/** 便捷打开标注编辑器（组件外可直接调用） */
export const openAnnotation = (session: AnnotationSession) => useAnnotationStore.getState().open(session);
