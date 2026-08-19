/**
 * 模型选择 / 解析助手。
 *
 * 历史包袱：本文件曾承载"渠道直连第三方"的动态适配器（buildDynamicAdapter
 * 按 baseUrl/apiKey 直接 fetch 各家 API）。阶段1步骤B 起，真实模型一律由管理端
 * catalog 下发、经唯一的 ManagedAdapter 接入，故直连机器已全部删除。
 *
 * 这里只保留"模型列表 / 默认模型 / 生效模型 key"的纯解析逻辑，数据源从
 * settingsStore.channels 切换为 catalogStore（管理端目录）。导出名保持不变，
 * 以免改动 panels / Frame 视图 / pluginRegistry。
 */

import type { NodeType } from "@/types";
import { SEEDANCE_FAMILY_ID, type Capability } from "@/contract";
import { getAdapter } from "./registry";
import { libtvModelOptions } from "./libtvAdapter";
import { dreaminaModelOptions } from "./dreaminaAdapter";
import { useCatalogStore } from "@/store/catalogStore";
import { useConnectionStore } from "@/store/connectionStore";
import { capabilityForNodeType } from "@/nodes/nodeSpecs";

/** 面板使用的模型选项（保持旧形状以兼容现有 UI；modeId/modeName 供按模式分组折叠，第131轮；
 *  familyId/familyName 供「家族→渠道/线路→模型」三级折叠，第163轮） */
export interface ModelOption {
  id: string; // 逻辑模型 id（= catalog model.id，也是 adapter.key）
  label: string;
  channelName: string;
  modelName: string;
  modeId?: string;
  modeName?: string;
  familyId?: string;
  familyName?: string;
}

function catalogModelsForCapability(cap: Capability): ModelOption[] {
  const st = useCatalogStore.getState();
  const modes = st.catalog?.modes;
  const fams = st.catalog?.families;
  return st
    .modelsByCapability(cap)
    .map((m) => ({
      id: m.id,
      label: m.label,
      channelName: "管理端",
      modelName: m.label,
      modeId: m.modeId,
      modeName: m.modeId ? modes?.find((x) => x.id === m.modeId)?.name || m.modeId : undefined,
      familyId: m.familyId,
      familyName: m.familyId ? fams?.find((x) => x.id === m.familyId)?.name || m.familyId : undefined,
    }));
}

/** 家族排序（catalog.families 序）——「家族→渠道/线路→模型」折叠的一级下拉顺序（非 hook，面板 memo 内用） */
export function catalogFamilyOrder(): string[] {
  return (useCatalogStore.getState().catalog?.families ?? []).map((f) => f.id);
}

/** 某能力的全部 catalog 模型（设置「模型」页统计/展示用） */
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
 * catalog 全量 × 模式门禁（第132轮删除「启用模型」子集——管理端下发即全部可用）。
 */
export function getChannelModelsForNodeType(nodeType: NodeType): ModelOption[] {
  const cat = capabilityForNodeType(nodeType);
  const all = catalogModelsForCapability(cat);
  // 模式门禁（第131轮，与 useCapModelOptions 同尺）：features.modes[modeId]===false 的模式整组隐藏
  const modeGates = useConnectionStore.getState().user?.features?.modes;
  const filtered = all.filter((m) => !m.modeId || modeGates?.[m.modeId] !== false);
  // 本地模型注入：LibTV/即梦 不是 catalog 模型（已授权且管理端未关入口时才出现；请求走本机 CLI 不经管理端）。
  // 家族归属（第163轮）：选项自带 familyId（LibTV 按款：Seedance/MiniMax；即梦全系 Seedance），
  // catalog 有同 id 家族时显示名跟随，否则用选项自带兜底名
  const fams = useCatalogStore.getState().catalog?.families;
  const locals = [...libtvModelOptions(cat), ...dreaminaModelOptions(cat)].map((o) => ({
    ...o,
    familyId: o.familyId ?? SEEDANCE_FAMILY_ID,
    familyName: fams?.find((f) => f.id === (o.familyId ?? SEEDANCE_FAMILY_ID))?.name || o.familyName || "Seedance 2.0",
  }));
  return [...filtered, ...locals];
}

/** 获取某节点类型 / 能力分类的默认模型 id（第132轮：设置「模型」页已删、无全局默认——自动取该能力第一个可用模型，
 *  与 ModelPicker.effectiveModelKey 的兜底同语义；catalog 无该能力模型时为 ""） */
export function getDefaultModelKey(nodeType: NodeType | Capability): string {
  return getChannelModelsForNodeType(nodeType as NodeType)[0]?.id ?? "";
}

const PLACEHOLDER_KEYS = new Set(["", "default", "auto"]);

/**
 * 解析画布节点真正生效的模型 key。
 * 两层：① 节点自带模型 → ② 该能力第一个可用模型（第132轮起的自动默认——真实 catalog 模型，非假值）；
 * 都没有（catalog 无该能力模型）→ 返回 ""（调用方报错，绝不给 mock/假模型——零兜底原则针对的是假值）。
 * 第三个参数仅用于识别"节点 model 是占位/mock 值"，不再作为回退结果。
 */
export function resolveActiveModelKey(
  nodeType: NodeType,
  modelParam: unknown,
  placeholderModel?: string,
): string {
  // 1. 节点自带的具体模型配置优先。
  // `*__fallback` 是历史版本兜底适配器写进节点的假值（适配器已删）——视为未选择，存量项目自愈。
  if (
    typeof modelParam === "string" &&
    !PLACEHOLDER_KEYS.has(modelParam) &&
    !modelParam.endsWith("__fallback") &&
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
 * 第132轮：自动取该能力第一个可用模型；无（catalog 无该能力模型）则返回 ""（调用方报错，不给假模型）。
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
