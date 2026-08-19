/**
 * uploadStore —— 本地素材上传 OSS 的「在途计数」，供素材区显示占位符+转圈。
 * 上传函数在开始/结束时 begin/end（按目标 key 计数），素材区读 count 渲染对应数量的占位缩略图。
 */
import { create } from "zustand";

interface UploadState {
	pending: Record<string, number>;
	begin: (key: string, n?: number) => void;
	end: (key: string, n?: number) => void;
}

export const useUploadStore = create<UploadState>((set) => ({
	pending: {},
	begin: (key, n = 1) => set((s) => ({ pending: { ...s.pending, [key]: (s.pending[key] || 0) + n } })),
	end: (key, n = 1) => set((s) => {
		const v = Math.max(0, (s.pending[key] || 0) - n);
		const p = { ...s.pending };
		if (v) p[key] = v; else delete p[key];
		return { pending: p };
	}),
}));

/** 目标 key：画布节点 / 分镜 */
export const uploadKeys = {
	node: (id: string) => `node:${id}`,
	shot: (epId: string, shotId: string) => `shot:${epId}:${shotId}`,
};

/** 读取某目标的在途上传数（组件用） */
export function usePendingUploads(key: string): number {
	return useUploadStore((s) => s.pending[key] || 0);
}
