/**
 * sharedPickStore —— 「添加到共享资产」目标选择弹窗的全局态（SharedPickModal 渲染）。
 * 三处右键入口（画布节点/资产助手/资产界面）解析好条目后 openSharedPick(items) 即弹窗选 库→文件夹 登记。
 */
import { create } from "zustand";
import type { SharedShareItem } from "@/services/sharedPublish";

interface SharedPickState {
	open: boolean;
	items: SharedShareItem[];
	/** 解析阶段被跳过的条目数（无结果/无 OSS 记录），弹窗内提示 */
	skipped: number;
	close: () => void;
}

export const useSharedPickStore = create<SharedPickState>((set) => ({
	open: false,
	items: [],
	skipped: 0,
	close: () => set({ open: false, items: [], skipped: 0 }),
}));

/** 打开目标选择弹窗；items 为空且无 skipped 时不弹（调用方自行提示）。 */
export function openSharedPick(items: SharedShareItem[], skipped = 0): void {
	useSharedPickStore.setState({ open: true, items, skipped });
}
