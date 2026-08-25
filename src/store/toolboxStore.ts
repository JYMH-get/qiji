/**
 * toolboxStore —— 大厅「AI 工具箱」（第245轮）的会话态与执行编排。
 *
 * 两个独立小工具（不依赖任何已打开的项目）：
 *  - 小说转剧本：purpose script.toScenes（正文=服务端模板 tool.novel2script，客户端只传 {{原文}} 变量）
 *  - 封面生成：purpose image.cover（正文=服务端模板 tool.cover.main，客户端只传 {{描述}} 变量 + size/quality）
 *
 * 状态放 store 而非弹窗组件：生成中关闭弹窗再打开，进度/结果仍在（会话级；不落盘、不进请求台账——
 * 工具产物与项目无关，结果提供 复制/下载/保存 即可）。
 * 生成一律走 runPurpose 唯一请求路径（§11.1），计费/日志/错误链路与正式界面完全一致。
 */
import { create } from "zustand";
import { runPurpose } from "@/services/purposeRunner";

export type ToolboxView = "home" | "novel" | "cover";

export interface CoverResult {
	/** 服务端资产公网 url（或 rawLink 时的上游时效直链） */
	url: string;
	/** 本机 objectURL（fetch 字节而来）——Tauri CSP 不允许 http(s) 图直显，展示一律走它 */
	objUrl: string;
	assetId?: string;
	at: number;
}

interface NovelState {
	input: string;
	tplId: string;
	modelKey: string;
	running: boolean;
	progress: number;
	/** 流式部分正文（running 期间实时刷新） */
	partial: string;
	result: string;
	error: string;
}

interface CoverState {
	desc: string;
	aspect: string;
	resolution: string;
	quality: string;
	tplId: string;
	modelKey: string;
	running: boolean;
	progress: number;
	error: string;
	/** 本次会话的生成历史（新在前） */
	results: CoverResult[];
}

interface ToolboxState {
	open: boolean;
	view: ToolboxView;
	novel: NovelState;
	cover: CoverState;
	setOpen: (open: boolean) => void;
	setView: (view: ToolboxView) => void;
	patchNovel: (p: Partial<NovelState>) => void;
	patchCover: (p: Partial<CoverState>) => void;
	/** 执行小说转剧本（effModelKey=组件解析好的生效文本模型；正在跑则忽略） */
	runNovel: (effModelKey: string) => Promise<void>;
	/** 执行封面生成（effModelKey=组件解析好的生效图像模型；正在跑则忽略） */
	runCover: (effModelKey: string) => Promise<void>;
}

const COVER_HISTORY_MAX = 12;

export const useToolboxStore = create<ToolboxState>((set, get) => ({
	open: false,
	view: "home",
	novel: { input: "", tplId: "", modelKey: "", running: false, progress: 0, partial: "", result: "", error: "" },
	cover: { desc: "", aspect: "9:16", resolution: "", quality: "high", tplId: "", modelKey: "", running: false, progress: 0, error: "", results: [] },

	setOpen: (open) => set({ open }),
	setView: (view) => set({ view }),
	patchNovel: (p) => set((s) => ({ novel: { ...s.novel, ...p } })),
	patchCover: (p) => set((s) => ({ cover: { ...s.cover, ...p } })),

	runNovel: async (effModelKey) => {
		const st = get().novel;
		if (st.running) return;
		const input = st.input.trim();
		if (!input) {
			get().patchNovel({ error: "请先粘贴小说原文" });
			return;
		}
		if (!effModelKey) {
			get().patchNovel({ error: "当前没有可用的文本模型（请先连接管理端）" });
			return;
		}
		get().patchNovel({ running: true, progress: 0, partial: "", result: "", error: "" });
		const r = await runPurpose("script.toScenes", {
			variables: { 原文: input },
			templateId: st.tplId || undefined,
			modelKey: effModelKey,
			onProgress: (progress, _status, partialText) => {
				const p: Partial<NovelState> = { progress };
				if (partialText !== undefined) p.partial = partialText;
				get().patchNovel(p);
			},
		});
		if (r.status === "success") {
			get().patchNovel({ running: false, progress: 100, result: r.resultUri, partial: "" });
		} else if (r.status === "failed") {
			get().patchNovel({ running: false, error: r.error || "生成失败" });
		} else {
			get().patchNovel({ running: false, error: "当前没有可用的文本模型（请先连接管理端）" });
		}
	},

	runCover: async (effModelKey) => {
		const st = get().cover;
		if (st.running) return;
		const desc = st.desc.trim();
		if (!desc) {
			get().patchCover({ error: "请先描述封面内容" });
			return;
		}
		if (!effModelKey) {
			get().patchCover({ error: "当前没有可用的图像模型（请先连接管理端）" });
			return;
		}
		// size/quality 与资产模式同尺（genParams.resolveSize），分辨率档由组件按模型 catalog 收敛后写入
		const { resolveSize } = await import("@/lib/genParams");
		const size = resolveSize(st.aspect, st.resolution || "2k");
		get().patchCover({ running: true, progress: 0, error: "" });
		const r = await runPurpose("image.cover", {
			variables: { 描述: desc },
			templateId: st.tplId || undefined,
			modelKey: effModelKey,
			params: { size, quality: st.quality || "high" },
			onProgress: (progress) => get().patchCover({ progress }),
		});
		if (r.status === "success") {
			// Tauri CSP 不允许 http(s) 图直显 → fetch 字节转 objectURL 展示（connect-src 放行 http/https）
			let objUrl = "";
			try {
				const resp = await fetch(r.resultUri);
				if (resp.ok) objUrl = URL.createObjectURL(await resp.blob());
			} catch {
				/* 拿不到字节时回退远程 url（浏览器 dev 可显示；Tauri 下提示保存查看） */
			}
			const item: CoverResult = { url: r.resultUri, objUrl, assetId: r.assetId, at: Date.now() };
			const results = [item, ...get().cover.results];
			// 超出上限的旧 objectURL 释放，防会话内存泄漏
			for (const drop of results.slice(COVER_HISTORY_MAX)) {
				if (drop.objUrl) URL.revokeObjectURL(drop.objUrl);
			}
			get().patchCover({ running: false, progress: 100, results: results.slice(0, COVER_HISTORY_MAX) });
		} else if (r.status === "failed") {
			get().patchCover({ running: false, error: r.error || "生成失败" });
		} else {
			get().patchCover({ running: false, error: "当前没有可用的图像模型（请先连接管理端）" });
		}
	},
}));
