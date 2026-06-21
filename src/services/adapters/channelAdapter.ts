/**
 * 模型选择 / 解析助手。
 *
 * 历史包袱：本文件曾承载"渠道直连第三方"的动态适配器（buildDynamicAdapter
 * 按 baseUrl/apiKey 直接 fetch 各家 API）。阶段1步骤B 起，真实模型一律由管理端
 * catalog 下发、经唯一的 ManagedAdapter 接入，故直连机器已全部删除。
 *
 * 这里只保留"模型列表 / 默认模型 / 生效模型 key"的纯解析逻辑，数据源从
 * settingsStore.channels 切换为 catalogStore（管理端目录）。导出名保持不变，
 * 以免改动 panels / Frame 视图 / batchExecutor / pluginRegistry。
 */

import type { NodeType } from "@/types";
import type { Capability } from "@/contract";
import { getAdapter } from "./registry";
import { useSettingsStore } from "@/store/settingsStore";
import { useCatalogStore } from "@/store/catalogStore";

/** 节点类型 → 能力分类（用于从 catalog/defaults 取对应模型） */
const NODE_TYPE_TO_CAT: Record<string, Capability> = {
  text: "text",
  script: "text",
  image: "image",
  video: "video",
  audio: "audio",
};

/** 面板使用的模型选项（保持旧形状以兼容现有 UI） */
export interface ModelOption {
  id: string; // 逻辑模型 id（= catalog model.id，也是 adapter.key）
  label: string;
  channelName: string;
  modelName: string;
}

function catalogModelsForCapability(cap: Capability): ModelOption[] {
  return useCatalogStore
    .getState()
    .modelsByCapability(cap)
    .map((m) => ({
      id: m.id,
      label: m.label,
      channelName: "管理端",
      modelName: m.label,
    }));
}

/** 某能力的全部 catalog 模型（设置里"启用模型"多选器用，不受 selectedModels 影响） */
export function getModelsForCapability(cap: Capability): ModelOption[] {
  return catalogModelsForCapability(cap);
}

/** catalog 下发的全部模型（设置 UI 下拉用） */
export function getAllChannelModels(): ModelOption[] {
  return useCatalogStore.getState().models().map((m) => ({
    id: m.id,
    label: m.label,
    channelName: "管理端",
    modelName: m.label,
  }));
}

/**
 * 某节点类型可选的模型（面板下拉数据源）。
 * 若用户在设置里勾选了子集（selectedModels），按勾选过滤；未勾选则展示该能力全部。
 */
export function getChannelModelsForNodeType(nodeType: NodeType): ModelOption[] {
  const cat = NODE_TYPE_TO_CAT[nodeType] ?? "text";
  const all = catalogModelsForCapability(cat);
  const selected = useSettingsStore.getState().selectedModels[cat] ?? [];
  if (selected.length === 0) return all;
  const allow = new Set(selected);
  return all.filter((m) => allow.has(m.id));
}

/** 获取某节点类型 / 能力分类的默认模型 id（来自设置） */
export function getDefaultModelKey(nodeType: NodeType | Capability): string {
  const { imageDefaults, videoDefaults, textDefaults, audioDefaults } = useSettingsStore.getState();
  const cat = NODE_TYPE_TO_CAT[nodeType] ?? "text";
  const defaults = { image: imageDefaults, video: videoDefaults, text: textDefaults, audio: audioDefaults }[cat];
  return defaults?.defaultModelId ?? "";
}

const PLACEHOLDER_KEYS = new Set(["", "default", "auto"]);

/**
 * 解析画布节点真正生效的模型 key。
 * 只有两层、无任何兜底：① 节点自带模型 → ② 设置面板里选的模型；都没有 → 返回 ""（调用方报错，不给假模型）。
 * 第三个参数仅用于识别"节点 model 是占位/mock 值"，不再作为回退结果。
 */
export function resolveActiveModelKey(
  nodeType: NodeType,
  modelParam: unknown,
  placeholderModel?: string,
): string {
  // 1. 节点自带的具体模型配置优先
  if (
    typeof modelParam === "string" &&
    !PLACEHOLDER_KEYS.has(modelParam) &&
    modelParam !== placeholderModel
  ) {
    return modelParam;
  }

  // 2. 设置面板里选的模型（唯一配置层）
  const defaultSettingKey = getDefaultModelKey(nodeType);
  if (defaultSettingKey && getAdapter(defaultSettingKey)) {
    return defaultSettingKey;
  }

  // 无可用模型：返回空，由调用方报错（绝不退回 mock）
  return "";
}

/**
 * 解析资产 / 表格模式下生效的模型 key。
 * 单一配置层（设置面板）；无则返回 ""（调用方报错，不兜底）。
 */
export function resolveAssetModelKey(category: Capability): string {
  const defaultSettingKey = getDefaultModelKey(category);
  if (defaultSettingKey && getAdapter(defaultSettingKey)) {
    return defaultSettingKey;
  }
  return "";
}

/** 兼容旧调用：逻辑模型 id 即 adapter key，无需再拼 channelId */
export function channelModelKey(_channelId: string, modelName: string): string {
  return modelName;
}

/** 兼容旧调用：catalog 体系下 key 即模型 id */
export function parseAdapterKey(key: string): { channelId: string; modelName: string } | null {
  if (!key) return null;
  return { channelId: "", modelName: key };
}

export { NODE_TYPE_TO_CAT };
