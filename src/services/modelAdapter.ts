/**
 * 统一 Model Hub 适配层。所有真实模型由管理端 catalog 下发，经唯一的
 * ManagedAdapter 收敛为同一契约（不再有 Seedance/GVLM/Lib 等直连分支）。
 * 一鱼多吃：驱动底部操作面板（modes + paramsSchema）、积分预估（estimateCost）、Agent 能力声明。
 *
 * 节点对外只展示结果（图片/视频/文本/脚本/音频）；"换模型 = 换 schema"，
 * 底部面板随选中模型动态重渲，结果显示不变。
 */

export type {
  ParamType,
  ParamField,
  CapabilityMode,
  SubmitResult,
  PollResult,
  ModelAdapter,
} from "./adapters/types";

export {
  registerAdapter,
  getAdapter,
  listAdapters,
  listAdaptersForNodeType,
} from "./adapters/registry";

export { mockAdapter } from "./adapters/mockAdapter";
export { buildManagedAdapter, syncManagedAdapters } from "./adapters/managedAdapter";

// 注册内置适配器（mock 兜底）；真实模型经 catalog → ManagedAdapter 动态注册
import "./adapters/index";