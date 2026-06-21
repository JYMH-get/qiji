/**
 * Qiji 共享契约 v1 —— 用户端(Tauri) 与 管理端(Web) 共用的唯一协议定义。
 *
 * 放置建议：作为独立包 `packages/shared/contract.ts`，两端通过 import 引用，
 * 保证协议永不脱节。管理端若用非 TS 语言，则以此文件为权威参考另行实现。
 *
 * 设计要点（已在需求规格中锁定）：
 *  - 用户端只认识管理端一个地址 + 一个 userAccessKey，绝不直连第三方。
 *  - id 是真理，url 是缓存（可过期，凭 id 向管理端重解析）。
 *  - 资产 id 全局单调递增、永不复用，由管理端分配。
 *  - 任务四态归一：queued / running / success / failed。
 *  - 出图提示词：LLM 直接产出**整段出图模板**（2026-06-21 第26轮锁定，推翻原"槽位+catalog模板合成"方案）。
 */

// ============================================================
// 1. 基础枚举
// ============================================================

/** 能力类型 */
export type Capability = "text" | "image" | "video" | "audio";

/** 资产大类（用户可见四类；群像并入角色用 importance 标记） */
export type AssetType = "character" | "scene" | "creature" | "prop";

/** 任务用途：决定管理端选哪个模板 / 哪个输出 schema / 路由到哪个第三方 */
export type Purpose =
  | "script.toScenes"        // 小说原文 → 分场剧本
  | "script.analyze"         // 剧本 → 资产体系(角色/场景/生物/道具/分集)
  | "storyboard.split"       // 单集剧本 → 大分镜卡(scriptContent + duration)
  | "storyboard.toVideoPrompt" // 分镜 → 视频生成提示词(visualDescription，保留 {角色:}{场景:}{音频:} 公式)
  | "asset.character.image"  // 角色基础形象（文生图）
  | "asset.character.variant"// 角色变体（图生图）
  | "asset.scene.image"
  | "asset.scene.variant"
  | "asset.creature.image"
  | "asset.creature.variant"
  | "asset.prop.image"
  | "asset.prop.variant"
  | "video.generate"         // 视频生成
  | "audio.tts";             // 文本转语音

/** 任务状态（管理端把各家 vendor 状态映射到这四态） */
export type TaskStatus = "queued" | "running" | "success" | "failed";

// ============================================================
// 2. 素材引用（id 真理 / url 缓存 / 支持未完成依赖）
// ============================================================

/**
 * 输入素材引用。三选一来源：
 *  - 已有资产：填 id（+ 可选 url 双重保险）
 *  - 公网素材：填 url
 *  - 未完成依赖：填 fromTask（+ part 指定取上游产物的哪部分）
 */
export interface AssetRef {
  id?: string;
  url?: string;
  /** 依赖某个尚未完成的任务的产物 */
  fromTask?: string;
  /** 取上游产物的哪一部分（如视频尾帧 / 末2秒） */
  part?: "full" | "tail_frame" | "last_2s";
}

/** 管理端返回的成品资产 */
export interface AssetOut {
  id: string;        // 全局唯一、单调递增
  type: Capability;  // 产物模态
  url: string;       // 公网可查（可能过期，凭 id 重解析）
  meta?: Record<string, unknown>;
}

// ============================================================
// 3. 生成请求 / 任务状态
// ============================================================

export interface GenerateRequest {
  purpose: Purpose;
  /** 逻辑模型 id（来自 catalog），如 "gpt-5.5" / "Image-2" */
  model: string;
  /** 选中的提示词模板 id（来自 catalog）；正文存管理端 */
  templateId?: string;
  /** 喂给模板的变量，如 { 视觉风格, 原文, 历史资产, 已有视觉圣经 } */
  variables?: Record<string, string>;
  /** 输入素材（按模态分组） */
  inputs?: {
    texts?: AssetRef[];
    images?: AssetRef[];
    videos?: AssetRef[];
    audios?: AssetRef[];
  };
  /** 模型字段，如 { duration, aspect_ratio, size, temperature } */
  params?: Record<string, unknown>;
  /** 期望返回格式 */
  output?: {
    format: "json" | "text" | "asset";
    /** 结构化输出 schema id（来自 catalog），如 "asset.extract.v1" */
    schemaId?: string;
  };
  /** 高级用户可覆盖模板正文（默认空，用 templateId） */
  promptOverride?: string;
  /** 幂等 + 链路追踪；批量去重凭此 */
  clientTaskId: string;
  /** 定时提交（ISO 时间）；空=立即 */
  scheduledAt?: string;
  /** 归属项目（项目间资产隔离） */
  projectId: string;
}

export interface TaskState {
  taskId: string;
  clientTaskId?: string;
  status: TaskStatus;
  progress: number;            // 0-100
  submittedAt?: string;
  finishedAt?: string;
  result?: {
    /** 异步产物（图/视频/音频） */
    assets?: AssetOut[];
    /** 文本结构化产物（已按 schema 校验的 JSON） */
    json?: unknown;
    /** 纯文本产物 */
    text?: string;
  };
  error?: string;
}

// ============================================================
// 4. 批量（并发容灾）
// ============================================================

export interface BatchRequest {
  projectId: string;
  tasks: GenerateRequest[];
}

export interface BatchState {
  batchId: string;
  tasks: Pick<TaskState, "taskId" | "clientTaskId" | "status" | "progress">[];
  summary: { total: number; success: number; failed: number; running: number; queued: number };
}

// ============================================================
// 5. 资产上传
// ============================================================

export interface AssetUploadResult {
  id: string;
  url: string;
}

// ============================================================
// 6. Catalog（远程下发：模型/模板/节点/schema/出图模板/变体前缀）
// ============================================================

export interface ParamField {
  key: string;
  label: string;
  type: "text" | "textarea" | "enum" | "number" | "boolean";
  options?: string[];
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface CatalogModel {
  id: string;            // 逻辑模型 id
  label: string;
  capability: Capability;
  params: ParamField[];  // 该模型在面板里暴露的参数表单
  cost: number;          // 基准积分
}

export interface CatalogTemplate {
  id: string;            // 模板 id（提交时用 templateId 引用）
  name: string;          // 界面显示名（用户选模板）
  capability: Capability;
  /** 用途；画风等"预设类"模板无 purpose（不可执行，仅作配置项下发） */
  purpose?: Purpose;
  /** 分类（管理端按类型归档，便于查找），如 "画风"、"资产提取"、"分镜生图" */
  category?: string;
  variables: string[];   // 该模板需要的变量名
  schemaId?: string;     // 绑定的输出 schema
  nodeTypes?: string[];  // 节点类型白名单：可用于哪些画布节点（空/缺省=不限）
  isDefault?: boolean;   // 该 purpose / 节点类型下默认选中
  bodyPreview?: string;  // 可选：正文预览（正文权威在管理端）
  /** 完整正文：仅对预设类模板（如画风）下发，供客户端直接取值 */
  body?: string;
  /** 参考图（data URL），如画风参考图 */
  images?: string[];
}

export interface CatalogNode {
  type: AssetType | "video" | "storyboard";
  label: string;
  icon: string;
  paramsSchema: ParamField[];
  ports?: { inputs: string[]; outputs: string[] };
}

/** 出图模板：basePrompt = prefix + {槽位} + suffix；每类资产 × 每画风一套 */
export interface CatalogImageTemplate {
  id: string;
  assetType: AssetType;
  style: string;          // 画风，如 "3D国风动画"
  prefix: string;         // 固定前缀（统一风格 + 排版 + 镜头 + 布光 + 画质）
  slotOrder: string[];    // 槽位拼接顺序
  suffix: string;         // 固定负面约束（以"不要"开头）
}

/** 变体前缀：图生图"保 DNA 不变"前缀；每类资产一套（角色/场景/生物/道具） */
export interface CatalogVariantPrefix {
  assetType: AssetType;
  prefix: string;         // 含 {{变体描述}} {{视觉风格}} 占位
}

export interface Catalog {
  version: string;
  models: CatalogModel[];
  templates: CatalogTemplate[];
  nodes: CatalogNode[];
  imageTemplates: CatalogImageTemplate[];
  variantPrefixes: CatalogVariantPrefix[];
  /** 输出 schema 字典（schemaId → JSON Schema） */
  schemas: Record<string, unknown>;
}

// ============================================================
// 7. 资产提取输出（schemaId = "asset.extract.v1"）—— 槽位版
// ============================================================

export interface VisualBible {
  mainStyle: string;
  auxStyle: string;
  coreColors: string;
  coreMaterials: string;
  characterAesthetic: string;
  sceneAesthetic: string;
  propStyle: string;
  cameraLanguage: string;
  nonRealistic: string;
  forbiddenDrift: string;
}

/** 角色出图槽位（LLM 填；basePrompt 由 出图模板 + 这些槽位合成） */
export interface CharacterSlots {
  身份: string;
  年龄: string;
  体型: string;
  气质: string;
  脸型五官: string;
  眼神: string;
  发型: string;
  发色: string;
  服装: string;
  主色调: string;
  辅色: string;
  标志特征: string;
}

export interface AssetVariant {
  code: string;            // 如 C01A
  name: string;
  inheritFrom: string;     // 父资产 code
  changeOnly: string[];    // 本次只允许变化
  lockUnchanged: string[]; // 不可变化项
  variantPrompt: string;   // 变体描述（配 catalog 变体前缀 + 基础图做图生图）
}

export interface CharacterAsset {
  code: string;            // C/A，群像用 importance:"crowd"
  name: string;
  importance: "core" | "supporting" | "crowd";
  gender: string;
  ageLook: string;
  voiceHint: string;       // 音色（界面字段，留给 TTS）
  coreFeatures: string;
  philosophy: string;
  slots: CharacterSlots;   // ← 出图槽位（取代内联 basePrompt）
  /** 派生：由 出图模板 + slots 合成；提取阶段可留空，由两端按需合成 */
  composedPrompt?: string;
  variants: AssetVariant[];
}

export interface SceneSlots {
  空间方向: string;
  核心结构: string;
  主要路径: string;
  持续结构: string;
  光源方向: string;
  危险来源方向: string;
  整体氛围: string;
}

export interface SceneAsset {
  code: string;            // S
  name: string;
  isTemporary: boolean;
  slots: SceneSlots;
  composedPrompt?: string;
  variants: AssetVariant[];
}

export interface CreatureAsset {
  code: string;            // M
  name: string;
  isTemporary: boolean;
  coreFeatures: string;
  slots: Record<string, string>; // 生物槽位（外形/材质/结构/激活态）
  composedPrompt?: string;
  variants: AssetVariant[];
}

export interface PropAsset {
  code: string;            // P
  name: string;
  category: "道具" | "武器" | "法宝" | "系统物";
  isTemporary: boolean;
  coreFeatures: string;
  slots: Record<string, string>;
  composedPrompt?: string;
  variants: AssetVariant[];
}

export interface Episode {
  index: number;
  title: string;
  summary: string;
  sourceRange: string;     // 对应原文范围
}

export interface AssetLedger {
  filteredTemporary: string[]; // 判为临时、不出图
  deprecated: string[];        // 作废、后续禁止引用
}

/** 剧本分析的完整结构化输出 */
export interface AssetExtractResult {
  visualBible: VisualBible;
  characters: CharacterAsset[];
  scenes: SceneAsset[];
  creatures: CreatureAsset[];
  props: PropAsset[];
  episodes: Episode[];
  ledger: AssetLedger;
}

// ============================================================
// 8. 分镜输出（schemaId = "storyboard.v1"）—— 草案，阶段3定稿
// ============================================================

export interface Shot {
  index: number;
  plot: string;                 // 分镜剧情
  dialogue: string;             // 对话/旁白，不增不删，≤30字，无则"无"
  dynamicVideoPrompt: string;   // 动态视频提示词
  refCharacters: string[];      // 引用角色 code（自动匹配资产的抓手）
  refScenes: string[];
  refProps: string[];
  durationSec: number;          // ≤15
}

export interface StoryboardResult {
  episodeIndex: number;
  shots: Shot[];
}

// ============================================================
// 9. HTTP 端点常量（两端共用，避免硬编码字符串漂移）
// ============================================================

export const Endpoints = {
  login: "/v1/login",
  heartbeat: "/v1/heartbeat",
  catalog: "/v1/catalog",
  generate: "/v1/generate",
  task: (taskId: string) => `/v1/tasks/${taskId}`,
  batch: "/v1/batch",
  batchState: (batchId: string) => `/v1/batch/${batchId}`,
  assets: "/v1/assets",
} as const;

/** 用户信息（登录/心跳返回） */
export interface SessionUser {
  id: string;
  name: string;
  credits: number;
}
