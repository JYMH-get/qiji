/**
 * directorStore —— 3D 导演台（可嵌入模型舞台）的全局会话态。
 *
 * 三种唤起：独立导演台（stage 网格）/ 图片垫底（image）/ 720°全景（pano）；
 * embed 回调存在时=涂鸦嵌入模式（产物交回涂鸦编辑器，不落画布节点）。
 */
import { create } from "zustand";
import type { StageSceneDoc } from "@/lib/stageScene";

export interface DirectorEmbedResult {
	/** 模型层位图（透明背景，尺寸=底图） */
	blob: Blob;
	scene: StageSceneDoc;
	camera: { theta: number; phi: number; dist: number; target: [number, number, number]; projection?: "persp" | "ortho" };
}

export interface DirectorSession {
	mode: "stage" | "image" | "pano";
	/** 底图/全景显示源（image/pano 模式必带） */
	uri?: string;
	fallbackUri?: string;
	name?: string;
	/** 底图/全景的资产 id（产物节点 stage3d.srcAssetId 溯源用） */
	srcAssetId?: string;
	/** 初始场景 JSON（再编辑） */
	scene?: unknown;
	/** 初始相机（涂鸦再编辑还原视角） */
	camera?: { theta: number; phi: number; dist: number; target: [number, number, number]; projection?: "persp" | "ortho" };
	/** 产物落点来源节点（右侧新建）；场景也写回该节点 data.stage3d */
	sourceNodeId?: string;
	/** 涂鸦嵌入：完成时回调（透明模型层+场景），不落画布节点 */
	embed?: { onDone: (r: DirectorEmbedResult) => void; width: number; height: number };
}

interface DirectorState {
	session: DirectorSession | null;
	open: (session: DirectorSession) => void;
	close: () => void;
}

export const useDirectorStore = create<DirectorState>((set) => ({
	session: null,
	open: (session) => set({ session }),
	close: () => set({ session: null }),
}));

export const openDirectorStage = (session: DirectorSession) => useDirectorStore.getState().open(session);
