/**
 * assetCheckStore —— 「检查素材」的进度/报告态（全局单例，供 AssetCheckModal 渲染）。
 * 检查=逐个资产探 OSS 直链是否可达、死链且本机有本地副本则自动重传修复（见 services/assetCheck）。
 */
import { create } from "zustand";

export type CheckStatus = "ok" | "healed" | "dead" | "failed" | "missing";
export interface CheckItemResult {
	id: string;
	name?: string;
	status: CheckStatus;
	/** failed 时的失败原因（HTTP 码 + 服务端文案 / 网络异常），逐条显示给用户 */
	reason?: string;
}
export interface CheckReport {
	total: number;
	ok: number; // 直链正常（含「服务端链接换过、已自动换用新链」）
	healed: number; // 死链→已用本地副本修复
	dead: number; // 死链且无本地副本，无法修复
	/** ⚠ 与 dead 分开（第254轮）：本机**有**副本，只是重传失败（多为对象存储 PUT 抖动）——
	 * 可直接重试；旧版把它并进 dead 显示成「无本地副本」，是彻底误导的结论（用户实报） */
	failed: number;
	/** 无 OSS 记录（异常）：按「OSS 链接提交 + 本地预览」模式，软件内素材都应有 OSS 记录——
	 * 反查不到台账 id、或服务端台账里已无此资产的素材不是"跳过"而是问题本身（第121轮用户定），
	 * 列名单提示重新上传/生成 */
	missing: number;
	items: CheckItemResult[];
}

interface AssetCheckState {
	open: boolean;
	title: string;
	running: boolean;
	total: number;
	done: number;
	report: CheckReport | null;
	empty: boolean; // 没有可检查的素材
	start: (title: string, total: number) => void;
	setProgress: (done: number) => void;
	finish: (report: CheckReport) => void;
	showEmpty: (title: string) => void;
	close: () => void;
}

export const useAssetCheckStore = create<AssetCheckState>((set) => ({
	open: false,
	title: "",
	running: false,
	total: 0,
	done: 0,
	report: null,
	empty: false,
	start: (title, total) => set({ open: true, title, running: true, total, done: 0, report: null, empty: false }),
	setProgress: (done) => set({ done }),
	finish: (report) => set({ running: false, report }),
	showEmpty: (title) => set({ open: true, title, running: false, total: 0, done: 0, report: null, empty: true }),
	close: () => set({ open: false, running: false, report: null, empty: false }),
}));
