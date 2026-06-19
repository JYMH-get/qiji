/**
 * 统一 Model Hub 适配层。Seedance / Kling / Wan / Lib Image / GVLM 等收敛为同一契约。
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

export { gvlmTextAdapter } from "./adapters/gvlmTextAdapter";
export { gvlmScriptAdapter } from "./adapters/gvlmScriptAdapter";
export { libImageAdapter } from "./adapters/libImageAdapter";
export { seedanceAdapter } from "./adapters/seedanceAdapter";
export { libAudioAdapter } from "./adapters/libAudioAdapter";
export { mockAdapter } from "./adapters/mockAdapter";

// 注册所有内置适配器
import "./adapters/index";