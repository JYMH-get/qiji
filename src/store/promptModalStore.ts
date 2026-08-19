/**
 * promptModalStore —— 全局「提示词放大编辑」弹窗。
 *
 * 任意存放提示词的面板都可点「放大」按钮调用 openPrompt(...) 打开大编辑器查看/编辑；
 * 保存经 onSave 回写原字段。弹窗在 App 根挂一次（<PromptModal/>）。
 */
import type { ReactNode } from "react";
import { create } from "zustand";
import type { ShotMaterial } from "@/services/projectFile";
import type { ProjectAssetCandidate } from "@/lib/projectAssets";
import type { PresetOption } from "@/lib/presetSchemes";

/** 弹窗提供给素材栏的能力：把 @ImageN 等文本插入到提示词光标处 */
export interface PromptModalApi {
	insertAtCursor: (text: string) => void;
}

/** 输入 @ 时的可选素材（待选框列出）：tag=@ImageN，附缩略图/名字 */
export interface MentionCandidate {
	tag: string;
	name?: string;
	uri?: string;
	media?: "image" | "video" | "audio";
}

/** 输入 # 导入项目资产：把资产加入宿主素材区，返回其 @tag + 素材数据（供立即插入胶囊）；返回 null=失败 */
export type ImportAssetFn = (cand: ProjectAssetCandidate) => { tag: string; mat: ShotMaterial } | null;

/**
 * 「匹配资产」：由**宿主**执行其现成的完整匹配逻辑（画布=applyAssetMatchToImageNode、
 * 资产模式=matchAssets——含音色声音参考与图例刷新），以弹窗当前草稿 draft 为提示词文本。
 * 返回更新后的提示词（含图例前缀，弹窗据此刷新草稿）+ 新增素材数；返回 null=未匹配到/无变化。
 */
export type MatchAssetsFn = (draft: string) => { prompt: string; added: number } | null;

export interface PromptModalConfig {
	title?: string;
	value: string;
	placeholder?: string;
	/** 只读（仅查看，无保存按钮） */
	readOnly?: boolean;
	/** 保存回调（readOnly 时忽略） */
	onSave?: (value: string) => void;
	/** 顶部素材栏渲染函数（收弹窗 api：可上传/引用/删除；画布=NodeMaterialBay，资产模式=分镜素材条） */
	extra?: (api: PromptModalApi) => ReactNode;
	/** 输入 @ 时的可选素材（每次调用读最新）；返回空/省略则不弹待选框 */
	mentions?: () => MentionCandidate[];
	/** 输入 # 导入项目资产（加入宿主素材区并返回 @tag）；省略则不启用 # */
	onImport?: ImportAssetFn;
	/** 「匹配资产」按钮：委托宿主现成匹配逻辑（省略则不显示按钮） */
	onMatchAssets?: MatchAssetsFn;
	/** 出图预设方案（每次读最新）：有则弹窗显示「预设方案」插入按钮 + 把 【预设:id】 渲染成 pill */
	presets?: () => PresetOption[];
}

interface PromptModalState {
	open: boolean;
	title: string;
	value: string;
	placeholder: string;
	readOnly: boolean;
	onSave?: (value: string) => void;
	extra?: (api: PromptModalApi) => ReactNode;
	mentions?: () => MentionCandidate[];
	onImport?: ImportAssetFn;
	onMatchAssets?: MatchAssetsFn;
	presets?: () => PresetOption[];
	openPrompt: (cfg: PromptModalConfig) => void;
	close: () => void;
}

export const usePromptModalStore = create<PromptModalState>((set) => ({
	open: false,
	title: "编辑提示词",
	value: "",
	placeholder: "",
	readOnly: false,
	onSave: undefined,
	extra: undefined,
	mentions: undefined,
	onImport: undefined,
	onMatchAssets: undefined,
	presets: undefined,
	openPrompt: (cfg) =>
		set({
			open: true,
			title: cfg.title ?? "编辑提示词",
			value: cfg.value ?? "",
			placeholder: cfg.placeholder ?? "",
			readOnly: !!cfg.readOnly,
			onSave: cfg.onSave,
			extra: cfg.extra,
			mentions: cfg.mentions,
			onImport: cfg.onImport,
			onMatchAssets: cfg.onMatchAssets,
			presets: cfg.presets,
		}),
	close: () => set({ open: false, onSave: undefined, extra: undefined, mentions: undefined, onImport: undefined, onMatchAssets: undefined, presets: undefined }),
}));
