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

/** 能力类型（video-enhance=视频超分、video-erase=视频去字幕、image-enhance=图像超分——火山引擎 MediaKit 处理类，与生成类分开以便模型选择器按能力过滤） */
export type Capability = "text" | "image" | "video" | "audio" | "video-enhance" | "video-erase" | "image-enhance";

/** 资产大类（用户可见四类；群像并入角色用 importance 标记） */
export type AssetType = "character" | "scene" | "creature" | "prop";

/** 任务用途：决定管理端选哪个模板 / 哪个输出 schema / 路由到哪个第三方 */
export type Purpose =
  | "script.toScenes"        // 小说原文 → 分场剧本
  | "script.analyze"         // 剧本 → 资产体系(角色/场景/生物/道具/分集)
  | "storyboard.split"       // 单集剧本 → 大分镜卡(scriptContent + duration)
  | "storyboard.toImagePrompt" // 分镜 → 故事板图像提示词(喂图像模型生成故事板单帧)
  | "storyboard.toVideoPrompt" // 分镜 → 视频生成提示词(visualDescription，保留 {角色:}{场景:}{音频:} 公式)；智能推理的**多卡**用途
  | "storyboard.singleShot"    // 单卡推理：单个分镜原文 → 本镜 故事板提示词+视频提示词（输出 1 卡；与多卡同一套卡解析）
  | "storyboard.unified"       // 图视同源·多卡：整集原文 → 每卡一段**同源提示词**（图片与视频共用同一提示词，unified_prompt）
  | "storyboard.unifiedShot"   // 图视同源·单卡：单个分镜原文 → 本镜一段**同源提示词**（输出 1 卡；与多卡同一套卡解析）
  | "asset.character.image"  // 角色基础形象（文生图）
  | "asset.character.variant"// 角色变体（图生图）
  | "asset.scene.image"
  | "asset.scene.variant"
  | "asset.creature.image"
  | "asset.creature.variant"
  | "asset.prop.image"
  | "asset.prop.variant"
  | "video.generate"         // 视频生成
  | "video.upscale"          // 视频超分/画质增强（火山引擎 MediaKit，inputs.videos[0] 为源视频）
  | "video.desub"            // 视频去字幕（火山引擎 MediaKit，inputs.videos[0] 为源视频）
  | "image.upscale"          // 图像超分/画质增强（火山引擎 MediaKit 同步接口，inputs.images[0] 为源图）
  | "image.viewangle"        // 图片转视角（多角度编辑器）：客户端只传机位参数（params.viewAngle），提示词由服务端按模板渲染（正文不下发）
  | "image.panorama"         // 720°全景：原图→equirectangular 2:1 全景图；前置提示词=服务端模板（正文不下发），客户端可带 params.panorama.custom 补充
  | "audio.tts"              // 文本转语音
  | "chat.reply"             // AI 对话回复（画布 AI对话节点，多轮记忆）
  | "chat.summarize";        // 简一助手对话总结（上下文超限时【总结本次对话】/【总结至新窗口继续】；提示词模板管理端维护，正文不下发）

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
  /** 资产名字（人读，便于上游 @tag 引用与日志追踪；id 为真理、url 为公网直链） */
  name?: string;
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
  /** 归属模式 id（第130轮，modes 注册表）；无=默认模式常开。客户端按 features.modes[modeId]===false 隐藏本模型 */
  modeId?: string;
  /** 归属家族 id（第163轮，families 注册表）：底层模型种类（Seedance 2.0/Sora2/GPT Image 2…）。
   *  客户端视频/图像模型选择四级「家族→渠道/线路→模型→要求」的一级筛选；无=归入「其他」分组。
   *  纯展示分组（门禁仍走 modeId；计费与家族无关） */
  familyId?: string;
  /** 支持的生成「方法」（第131轮，视频模型）：omni=全能参考 / frames=首尾帧；缺省=仅全能参考 */
  methods?: string[];
  /** 支持官方真人素材库（苏打水 gf 系）：客户端提供「真人图」多选 → params.officialAssetIndexes（0 基） */
  officialAssets?: boolean;
  /** 参考视频按秒计费折算系数（第140轮）：计费秒数 = duration + 系数 × Σceil(每条参考视频秒)。
   *  缺省/0=不计费。服务端探测时长并实扣；本字段供客户端预估展示（预估以服务端实扣为准） */
  refVideoSecondsWeight?: number;
  /** 素材数量上限（第145轮，管理端可调）：图/视/音 各自上限；键缺省=不限、0=不允许该类素材
   *  （如 933 收紧为 903 即「vid:0」禁垫视频）。服务端 generate/batch 硬闸 + 客户端提交前同尺预检，
   *  超限明确报错绝不静默裁剪（素材与 @tag 图例按位对齐，丢一个=整段错位） */
  matLimits?: { img?: number; vid?: number; aud?: number };
  /** 模型备注（第166轮，管理端「模型」页可编辑，用户可见）：客户端悬浮积分消耗图标时显示。
   *  未设=客户端默认显示该模型参考素材上限（matLimits 派生文案，见 src/lib/modelNote.ts） */
  note?: string;
  params: ParamField[];  // 该模型在面板里暴露的参数表单
  cost: number;          // 基准积分（固定/起步价）
  /** 按字段计费：参数键（如视频 "duration"）；扣费 = costPerUnit × 该字段值。空=按 cost 固定扣 */
  costField?: string;
  /** 每单位价（配合 costField）。路由可按档覆盖；客户端仅用于预估展示 */
  costPerUnit?: number;
  /** 计费规则（由管理端 routes 投影出的「条件→价」表，不含上游模型名）；客户端按档精确预估 */
  costRules?: { when: Record<string, string>; cost?: number; costPerUnit?: number }[];
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
  /** 预设方案的「互斥组」：同组预设不能同时出现在一段提示词（客户端插入其一即移除同组旧胶囊）；仅预设类有意义 */
  presetGroup?: string;
  /** 预设方案的默认插入位置：前缀/后缀；缺省=前缀 */
  presetPosition?: "prefix" | "suffix";
  schemaId?: string;     // 绑定的输出 schema
  nodeTypes?: string[];  // 节点类型白名单：可用于哪些画布节点（空/缺省=不限）
  isDefault?: boolean;   // 该 purpose / 节点类型下默认选中
  bodyPreview?: string;  // 可选：正文预览（正文权威在管理端）
  /** 完整正文：仅对预设类模板（如画风）下发，供客户端直接取值 */
  body?: string;
  /** 参考图（data URL），如画风参考图 */
  images?: string[];
}

/**
 * 预设（第174轮从提示词模板**数据层拆分**出的独立实体，服务端 presets.json）：
 * 无用途、不可执行的正文片段（画风/出图预设方案/资产拆分前后缀），catalog **全文下发**；
 * 客户端以「预设胶囊」`【预设:id】` 插入提示词，提交时展开成正文。
 */
export interface CatalogPreset {
  id: string;
  name: string;
  /** 分组："画风"（新建项目画风选择器 + 画风前缀）/ "预设方案"（出图预设胶囊）/ 其它自由分组 */
  category?: string;
  /** 完整正文（预设是正文片段，全文下发） */
  body: string;
  /** 插入位置：前缀（用户输入前）/后缀（用户输入后）；缺省=前缀 */
  position?: "prefix" | "suffix";
  /** 互斥组：同组预设不能同时出现在一段提示词（客户端插入其一即移除同组旧胶囊） */
  group?: string;
  /** 参考图（data URL），如画风参考图 */
  images?: string[];
  /** 自动附加范围（第174轮）：资产拆分完成时自动挂到这些类别资产的出图提示词上
   *  （characters/crowds/scenes/organisms/items；前缀还是后缀由 position 决定） */
  autoAttach?: string[];
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

/** Seedance 2.0 家族 id（第163轮，families 注册表种子）：本地 CLI 渠道（LibTV/即梦）的 Seedance
 *  模型不在 catalog，客户端注入时归入该家族（与服务端种子 id 保持一致，勿改） */
export const SEEDANCE_FAMILY_ID = "fam-seedance";

export interface Catalog {
  version: string;
  models: CatalogModel[];
  /** 模式注册表投影（第131轮）：id→显示名，客户端模型下拉按模式分组折叠（「源头」级）用 */
  modes?: { id: string; name: string }[];
  /** 家族注册表投影（第163轮）：id→显示名（有序），客户端「家族」一级下拉与排序用 */
  families?: { id: string; name: string; capability?: "video" | "image" }[];
  templates: CatalogTemplate[];
  /** 预设清单（第174轮独立实体）：画风/预设方案/前后缀 全文下发；旧服务端无此字段=客户端回退按模板分类取 */
  presets?: CatalogPreset[];
  nodes: CatalogNode[];
  imageTemplates: CatalogImageTemplate[];
  variantPrefixes: CatalogVariantPrefix[];
  /** 输出 schema 字典（schemaId → JSON Schema） */
  schemas: Record<string, unknown>;
  /** 第三方渠道手续费实价（第121轮：本用户实付价=渠道商售价覆盖 > 平台价；hidden 计费模型不进 models 下拉，故另设此字段供客户端预检/预估） */
  fees?: { thirdParty?: number };
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
  /** 注册体系（P2 商业化改造）：图形验证码 / 发验证码 / 邮箱·手机号注册（可填邀请码）/ 找回密码 */
  captcha: "/v1/captcha",
  registerSendCode: "/v1/register/send-code",
  registerAccount: "/v1/register/account",
  passwordSendCode: "/v1/password/send-code",
  passwordReset: "/v1/password/reset",
  /** 登录态自助修改密码（校验旧密码；不动 API 密钥——其它设备不掉线） */
  passwordChange: "/v1/password/change",
  bindAccount: "/v1/bind-account",
  /** API 密钥自助重置（第218轮：accessKey=身份凭证「API 密钥」；重置=其它设备/外部对接全部失效） */
  apiKeyRegenerate: "/v1/api-key/regenerate",
  heartbeat: "/v1/heartbeat",
  me: "/v1/me",
  /** 个人消耗统计（第173轮）：今日/昨日/近7天；团长可 ?userId= 查团员、?scope=team 查全团 */
  stats: "/v1/stats",
  redeem: "/v1/redeem",
  catalog: "/v1/catalog",
  generate: "/v1/generate",
  task: (taskId: string) => `/v1/tasks/${taskId}`,
  batch: "/v1/batch",
  batchState: (batchId: string) => `/v1/batch/${batchId}`,
  assets: "/v1/assets",
  /** 转存兜底：把上游直链下载并转存到 OSS，返回永久公网直链 + 资产 id */
  assetRehost: "/v1/assets/rehost",
  /** 引用上报（P1）：打开/保存项目时批量报 assetId → 服务端刷 last_ref_at（保留策略的唯一数据来源） */
  assetRef: "/v1/assets/ref",
  /** 收藏（P1）：按 assetId 落服务端 = 永久保留额度（旧的 localStorage 按 uri 存法换机即失效） */
  favorites: "/v1/favorites",
  favorite: (assetId: string) => `/v1/favorites/${assetId}`,
  favoriteFlags: "/v1/favorites/flags",
  /** 扩容卡核销（P1）：个人卡→本人收藏配额；团队卡→团长核销到团队共享库配额 */
  storageCodeRedeem: "/v1/storage-codes/redeem",
  /** 缩略图直传（P1）：256px WebP → thumb/ 前缀 */
  assetThumb: (id: string) => `/v1/assets/${id}/thumb`,
  assetThumbComplete: (id: string) => `/v1/assets/${id}/thumb/complete`,
  /** 第158轮：客户端接力转存回报——把 rehosted:false 任务响应体里的原始时效直链改写为真 OSS 台账资产
   *（断连找回/重连原任务再取结果拿到永久直链，不再重复下载+上传；请求记录 resultLink 同步生效） */
  taskResultAsset: (taskId: string) => `/v1/tasks/${taskId}/result-asset`,
  /** 批量下载清单（第232轮）：把本人请求记录里的成功产物摊平成可批量下载的条目 */
  downloadsManifest: "/v1/downloads/manifest",
  /** 本人请求记录（第110轮）：列表=提交/状态/积分扣退；详情只含 ①客户端→服务端 ②服务端→客户端 两段 */
  logs: "/v1/logs",
  log: (id: string) => `/v1/logs/${id}`,
  /** 共享素材库（第120轮）：三级=库/文件夹/素材；素材只存 OSS 记录（id+url），字节不复制 */
  sharedLibraries: "/v1/shared/libraries",
  sharedSearch: "/v1/shared/libraries/search",
  sharedJoin: (id: string) => `/v1/shared/libraries/${id}/join`,
  sharedLeave: (id: string) => `/v1/shared/libraries/${id}/leave`,
  sharedFolders: (libId: string) => `/v1/shared/libraries/${libId}/folders`,
  sharedFolderAssets: (folderId: string) => `/v1/shared/folders/${folderId}/assets`,
  /** 团队（第172轮）：团队码开团（开团者=团长）、成员绑定、积分方式（共享/分发）、分发/收回 */
  team: "/v1/team",
  teamMembers: "/v1/team/members",
  teamMember: (userId: string) => `/v1/team/members/${userId}`,
  teamInvite: (userId: string) => `/v1/team/invites/${userId}`,
  teamInviteAccept: "/v1/team/invites/accept",
  teamInviteDecline: "/v1/team/invites/decline",
  teamLeave: "/v1/team/leave",
  teamDissolve: "/v1/team/dissolve",
  teamCredits: "/v1/team/credits",
  teamLibFolder: (id: string) => `/v1/team/lib/folders/${id}`,
  teamLibAsset: (id: string) => `/v1/team/lib/assets/${id}`,
} as const;

// ── 团队（第172轮）：用户互相绑定——团长开团（需团队码）、团员绑定、积分共享/分发 ──
export type TeamCreditMode = "shared" | "dispatch";

/** 团队概要（随登录/心跳/个人中心下发）。共享模式团员的 SessionUser.credits=团队池余额（=团长余额） */
export interface SessionTeamInfo {
  id: string;
  name: string;
  role: "leader" | "member";
  creditMode: TeamCreditMode;
  leaderName?: string;
  memberCount: number;
  /** 共享积分模式下的团队池余额（=团长余额）；分发模式不下发 */
  poolCredits?: number;
  /** 团队共享素材库 id（开团自动创建，资产助手「共享资产」自动可见） */
  sharedLibId?: string;
}

/** 团员条目（GET /v1/team 团长视角） */
export interface TeamMemberInfo {
  id: string;
  name: string;
  account?: string;
  credits: number;
  dailySpent: number;
  totalSpent: number;
  lastSeenAt?: string;
  enabled: boolean;
  /** 团长对该团员的分发净额（分发+ / 收回−） */
  granted?: number;
  /** 本次可收回上限 = min(分发净额, 团员当前余额)——收回只认这口径，团员自有积分不可收缴 */
  reclaimable?: number;
}

/** 收到的入团邀请（GET /v1/team 未在团队时下发；接受才入团——邀请-同意制） */
export interface TeamInviteInfo {
  teamId: string;
  teamName: string;
  leaderName?: string;
  creditMode: TeamCreditMode;
  memberCount: number;
  createdAt: string;
}

// ── 批量下载清单（第232轮，GET /v1/downloads/manifest）──
// 服务端把请求记录里的成功产物摊平成条目。⚠ 转存失败回退的**上游原链**不在资产台账里，
// 只存在于请求记录，所以这份清单是取回它们的唯一途径。

/** 保存情况：产物链接指向哪儿 */
export type DownloadLinkStorage = "oss" | "oss-old" | "local" | "raw";
export type DownloadMediaKind = "image" | "video" | "audio" | "other";
/** 原链过期风险（各渠道原链 2~24h 不等；oss 恒 none） */
export type DownloadExpiryRisk = "none" | "low" | "high" | "expired";

export interface DownloadItem {
	logId: string;
	taskId?: string;
	user: string;
	startedAt: string;
	finishedAt?: string;
	purpose: string;
	purposeLabel: string;
	model: string;
	/** 同一条请求内的第几个产物 / 共几个（多图任务一条记录可能多个链接） */
	seq: number;
	total: number;
	url: string;
	storage: DownloadLinkStorage;
	kind: DownloadMediaKind;
	ext: string;
	/** 该链接下载须带上游密钥——密钥绝不外发，**直连必然失败**，只能由服务端代下 */
	authRequired: boolean;
	expiryRisk: DownloadExpiryRisk;
	/** 建议落盘相对路径：<用户>/<日期>/<步骤>_<logId>[_序号].<ext> */
	suggestedPath: string;
}

export interface DownloadManifest {
	generatedAt: string;
	total: number;
	/** 命中上限被截断（绝不静默截断——UI 须明确告知用户缩小范围分批取） */
	truncated: boolean;
	matched: number;
	byStorage: Record<DownloadLinkStorage, number>;
	byKind: Record<DownloadMediaKind, number>;
	authRequired: number;
	items: DownloadItem[];
}

/** 单个时间段的消耗统计（GET /v1/stats） */
export interface ConsumeRangeStats {
  /** 实际消耗积分（按请求日志聚合，失败已退款不计；共享积分模式下仍记在消耗者名下） */
  credits: number;
  count: number;
  success: number;
  failed: number;
  /** 按模型统计（成功次数 + 实际消耗积分；按次数降序） */
  byModel?: { model: string; count: number; success: number; credits: number }[];
  /** 按**家族池**统计（第173轮：统计页先看家族、点开看组内模型）；未归家族/已删模型归「其他」 */
  byFamily?: {
    familyId: string;
    familyName: string;
    count: number;
    success: number;
    credits: number;
    models: { model: string; count: number; success: number; credits: number }[];
  }[];
  /** 按步骤统计（label=步骤中文代称） */
  byPurpose?: { purpose: string; label: string; count: number; success: number; credits: number }[];
}

/** 个人/团员/全团消耗统计（GET /v1/stats） */
export interface UserConsumeStats {
  target: { id?: string; name?: string; scope?: "team" };
  ranges: { today: ConsumeRangeStats; yesterday: ConsumeRangeStats; week: ConsumeRangeStats };
}

/** 团队详情（GET /v1/team）：团长见全量（members），团员见概要 */
export interface TeamDetail extends SessionTeamInfo {
  /** 团队人数上限（含团长；生效值=本团覆盖 > 管理端全局默认） */
  memberLimit?: number;
  sharedLibName?: string;
  createdAt?: string;
  /** 团长余额（=池；仅团长视角下发） */
  leaderCredits?: number;
  /** 仅团长视角下发 */
  members?: TeamMemberInfo[];
  /** 已发出待接受的邀请（仅团长视角下发；可撤销） */
  pendingInvites?: { userId: string; name: string; account?: string; createdAt: string }[];
}

// ── 共享素材库（第120轮）：三级 = 共享资产库 / 共享文件夹 / 文件夹内素材 ──
/** 共享资产库（一级）：渠道商/源站创建、设加入密码；用户搜索+密码加入后才可见内容（渠道商区分） */
export interface SharedLibraryInfo {
  id: string;
  name: string;
  folderCount: number;
  assetCount: number;
}
/** 共享文件夹（二级）：count=文件夹内素材数（共享主页「获取」只拉这一层，惰性加载） */
export interface SharedFolderInfo {
  id: string;
  name: string;
  count: number;
}
/** 文件夹内素材（三级）：只存 OSS 记录——assetId 是真理（服务端按台账刷新直链），url 是缓存 */
export interface SharedAssetRecord {
  id: string;
  assetId?: string;
  url: string;
  name: string;
  mime?: string;
}

/** 本人请求记录条目（GET /v1/logs 列表项） */
export interface UserLogItem {
  id: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  purpose?: string;
  /** 步骤中文代称（服务端映射） */
  purposeLabel?: string;
  model?: string;
  status: "running" | "success" | "failed";
  /** 本次预扣积分 */
  cost?: number;
  /** 失败已退款/未扣（服务端派生：失败即退） */
  refunded?: boolean;
  error?: string;
  resultLink?: string;
}

/** 本人请求记录详情（GET /v1/logs/:id）：列表字段 + ①② 两段报文（③④上游报文不下发） */
export interface UserLogDetail extends UserLogItem {
  requestHeaders?: unknown;
  /** ① 客户端 → 服务端 的完整请求体 */
  request?: unknown;
  /** ② 服务端 → 客户端 的完整响应/结果 */
  response?: unknown;
}

/** 用户功能开关（服务端按用户控制客户端可用模式；字段缺省=开）。管理端用户表可编辑，随登录/心跳下发。 */
export interface UserFeatures {
  /** 资产（表格）模式：剧本编辑/五类资产页/视频表格工作台 */
  assetMode?: boolean;
  /** 画布模式：/frame-canvas 节点编辑器 */
  canvasMode?: boolean;
  /** 实时剪辑模式：/frame-editor 剪辑工作台 */
  editorMode?: boolean;
  /** LibTV 授权入口（个人中心连接 LibTV + Seedance 2.0 本地 CLI 生成）；生成走用户自己的 LibTV 账号，不经管理端 */
  libtv?: boolean;
  /** 即梦（Dreamina）授权入口（个人中心 OAuth 设备码登录 + Seedance 2.0 本地 CLI 生成）；生成走用户自己的即梦账号，不经管理端 */
  dreamina?: boolean;
  /** 动态视频模式开关（第130轮）modeId→bool（缺省=开）：关=该模式下模型客户端隐藏；服务端 generate/batch 亦 403 */
  modes?: Record<string, boolean>;
}

/** 用户信息（登录/心跳返回） */
export interface SessionUser {
  id: string;
  name: string;
  /** 积分余额。⚠ 共享积分模式的团员这里=团队池余额（=团长余额），显示/预检与服务端实扣天然一致 */
  credits: number;
  /** 团队概要（第172轮；不在团队则缺省） */
  team?: SessionTeamInfo;
  /** 功能开关（缺省=全开）；仅单模式时客户端隐藏 进入模式/模式切换/同步到画布 等交互键 */
  features?: UserFeatures;
}

/** 个人中心：积分 + 消耗统计（/v1/me 返回） */
export interface UserStats {
  id: string;
  name: string;
  /** 积分余额（共享积分模式的团员=团队池余额，同 SessionUser.credits 口径） */
  credits: number;
  /** 本人自己的积分余额（与 credits 不同仅发生在共享模式团员场景） */
  ownCredits?: number;
  /** 团队概要（第172轮；不在团队则缺省） */
  team?: SessionTeamInfo;
  totalSpent: number;
  dailySpent: number;
  note?: string;
  /** 已绑定的登录账号（未绑定为空） */
  account?: string;
  /** 我的个人邀请码（P2b）：新用户注册时填它 → 记录邀请关系（为后续邀请奖励留钩子） */
  inviteCode?: string;
  /** 已邀请注册的人数 */
  invitedCount?: number;
}
