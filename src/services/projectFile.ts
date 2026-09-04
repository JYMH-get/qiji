/**
 * projectFile.ts — .Qiji 项目文件序列化 / 反序列化
 *
 * 格式：JSON，支持类似 Git 的历史提交记录与分支指针模型。
 * Tauri 环境：直接读写磁盘 .Qiji 文件。
 * 浏览器降级：JSON 下载 / File API 读取。
 */
import type { CanvasNode, CanvasEdge, CanvasGroup } from "@/types";
import type { RtcDoc } from "@/types/rtc";

export const Qiji_VERSION = "2.0";
export const FILE_EXT = ".Qiji";

export interface CommitSnapshot {
  commitId: string;
  parentIds: string[];
  message: string;
  author: string;
  timestamp: string;
  canvas: {
    nodes: Record<string, CanvasNode>;
    edges: Record<string, CanvasEdge>;
    groups: Record<string, CanvasGroup>;
    viewport?: { x: number; y: number; zoom: number };
  };
  assets?: Record<string, import("@/store/libraryStore").Asset>;
}

export interface MigrationLogEntry {
  fromVersion: string;
  toVersion: string;
  migratedAt: string;
  description: string;
}

/**
 * 项目级模型配置（表格/画布单数据源双视图，模型配置同源共用一套）。
 * 统一字段：text/image/video/audio。`table*`/`canvas*` 为旧版双套字段，仅作旧项目读取兼容。
 */
export interface ProjectModelConfig {
  text?: string;
  image?: string;
  video?: string;
  audio?: string;
  /** 视频超分模型（火山 MediaKit，4 种版本=4 个模型） */
  "video-enhance"?: string;
  /** 视频去字幕模型（火山 MediaKit） */
  "video-erase"?: string;
  /** 图像超分模型（火山 MediaKit） */
  "image-enhance"?: string;
  /** @deprecated 旧版表格模式专用，已并入统一字段；仅兼容读取 */
  tableText?: string;
  /** @deprecated */ tableImage?: string;
  /** @deprecated */ tableVideo?: string;
  /** @deprecated */ tableAudio?: string;
  /** @deprecated 旧版画布模式专用，已并入统一字段；仅兼容读取 */
  canvasText?: string;
  /** @deprecated */ canvasImage?: string;
  /** @deprecated */ canvasVideo?: string;
  /** @deprecated */ canvasAudio?: string;
}

/** 资产造型预设/变体（UI 友好的轻量版；无变体时界面不显示占位卡片） */
export interface AssetVariantLite {
  id: string;
  label: string;       // 徽标，如 默认/战斗/日常、全景/特写/氛围
  name: string;        // 标题
  description: string;
  prompt?: string;     // 该变体的整段出图提示词（图生图/重绘用）
  image?: string;      // 选定主图
  images?: string[];   // 历史生成图
}

/** 在途生成任务（断连保护：持久化到项目，切页/重启后续跑或重试） */
export interface PendingGen {
  id: string;                 // 本地唯一 id
  taskId?: string;            // 上游任务 id（提交确认后才有）
  adapterKey?: string;        // 续跑轮询用
  /** 资产出图目标（asset 分支；shot 分支时为空） */
  cat?: "characters" | "scenes" | "items" | "organisms" | "crowds";
  assetId?: string;           // 目标资产实体 id
  variantId?: string | null;  // null=基础形象
  /** 分镜目标（shot 分支，切页/重启可凭 taskId 找回）：
   *  storyboard/video=出图/出视频；storyboardPrompt/videoPrompt=推理提示词（文本，落 shot.*Prompt + base） */
  shot?: { episodeId: string; shotId: string; field: "storyboard" | "video" | "storyboardPrompt" | "videoPrompt" };
  /** 媒体处理派生记录目标（超分/去字幕）：结果写回 shot.videoDerived / sbDerived（field=storyboard）里 recId 对应记录 */
  derived?: { episodeId: string; shotId: string; recId: string; field?: "video" | "storyboard" };
  purpose: string;            // Purpose
  prompt: string;
  /** 模板变量（推理用 variables 而非自由 prompt；存盘以便重试/续跑沿用同一输入） */
  variables?: Record<string, string>;
  /** catalog 模板 id（推理时的提示词模板）；重试/续跑沿用 */
  templateId?: string;
  params?: Record<string, unknown>;
  modelKey?: string;          // 生效模型（重试/续跑沿用同一模型；空=按设置默认解析）
  input?: Record<string, unknown>; // 额外输入（如图生图垫图 images:[{url}]）；重试/续跑沿用
  /** 垫图详情（可渲染预览 uri + 名称 + 资产 id）：供「详情」回看本次用了哪些垫图；完成后转存到 genMeta */
  refsMeta?: { name?: string; uri: string; id?: string }[];
  label: string;              // 展示用（资产名/造型）
  status: "running" | "failed";
  error?: string;
  /** 失败可凭原 taskId 重连找回（=服务端丢任务的 lost 态）；UI 据此显示「重连原任务」而非「重新生成」 */
  recoverable?: boolean;
  createdAt: number;
}

/**
 * 在途「智能推理」任务（断连保护 + 锁定）：一个上游 task 产出整集多镜头（流式）。
 * - 持久化到项目 → 切页不解锁、关客户端重开仍可凭 taskId 找回；
 * - 锁定语义：episode（多镜）或 shot（单镜）只要存在 running 记录，界面恒「推理中」、禁止二次点击；
 * - 找回：重开时对 running + 有 taskId 的记录重挂轮询，**仅补缺失字段**（已完成镜头不覆盖，防抹掉用户修改）。
 */
export interface InferTask {
  id: string;                 // 本地唯一 id
  episodeId: string;          // 目标分集
  mode: "multi" | "single" | "split"; // 多镜推理（整集）/ 单镜推理 / 智能拆分（整集拆镜头，仅原文分段）
  /** 图视同源模式：推理产出同源提示词（写 shot.unifiedPrompt），找回时凭此决定回填字段 */
  sameSource?: boolean;
  shotId?: string;            // single 模式的目标分镜
  taskId?: string;            // 上游任务 id（提交确认后才有 → 找回关键）
  adapterKey?: string;        // 续跑轮询用
  status: "running" | "failed";
  error?: string;
  createdAt: number;
}

/** 单张生成图的「请求详情」：出图提示词 + 垫图信息（按图片 uri 存，供展示区「详情」回看） */
export interface GenMeta {
  prompt: string;
  refs: { name?: string; uri: string; id?: string }[];
  at: number;
}

/** 记忆的垫图（按 `${cat}:${assetId}:${formKey}` 存，切走再回来不丢；可渲染 uri + 公网 url + 名称 + 资产 id） */
export interface RefImgMemo {
  id: string;
  uri: string;
  url?: string;
  name?: string;
}

/**
 * 资产二进制三元映射：一份素材同时记录
 *  - id：管理端分配的全局资产 id（端内自用 + 与管理端沟通的真理）
 *  - url：公网 url（OSS，兜底 + 跨用户项目互传加载）
 *  - localPath / localUri：本地原件路径与可显示 uri（convertFileSrc，项目秒级加载 + 拖出复制）
 */
export interface AssetBlob {
  id: string;
  url?: string;
  localPath?: string;
  localUri?: string;
  mime?: string;
  ext?: string;
  /** 拖出软件外时的小预览图本地路径（降采样，避免原图大小的巨大拖影） */
  thumbPath?: string;
  /** 落盘前的原始来源 uri（http/data/blob）——用于按界面显示的原 uri 反查回本 blob */
  srcUri?: string;
  /** 文件内容 sha256（十六进制）——本地上传去重：相同内容复用同一资产，不重复上传/落盘 */
  sha256?: string;
  /**
   * ⚠ 历史 url 别名表（第254轮，勿删）：url 换过之后的**旧链接**。
   *
   * 节点素材 / genMeta / assetRefImages 里散落的是写入当时的 url 字符串，而 url 会变
   * （旧 OSS 桥接恢复、别人先恢复过、reput 落到新键）。registerAssetBlob 换 url 时把旧值
   * 归档到这里、blobByUri 一并匹配——否则旧 uri 一换链就再也反查不回本 blob，
   * 自愈（healPublicUrlIfDead）永远命中不了，提交仍然发旧死链（用户实报）。
   * 上限 8 条，不含当前 url。
   */
  pastUrls?: string[];
}

/** 分镜的垫素材（来自资产库或本地上传） */
export interface ShotMaterial {
  id: string;
  assetId?: string;                                       // 资产库 id（本地上传则空）
  kind: "character" | "scene" | "creature" | "prop" | "local";
  /** 模态：图像/视频/音频（缺省按图像处理，兼容旧数据；资产库素材恒为图像）。
   *  决定缩略图渲染方式与发往上游时归入 images/videos/audios 哪一组（@ImageN/@VideoN/@AudioN）。 */
  media?: "image" | "video" | "audio";
  name: string;
  uri: string;                                            // 缩略图/图片/视频/音频（公网 url 或本地 uri）
  /** 本分镜中的引用用途；角色图片缺省 identity，用户可显式改为 reference；不改变全局资产身份。 */
  usage?: "reference" | "identity";
  /** 该素材若是「角色声音参考」音频：指向所属角色的资产 id（用于图例配对「@ImageN的声音参考@AudioM」）。 */
  voiceForAssetId?: string;
}

/** 视频处理派生记录（超分/去字幕，火山引擎）：显示在视频区历史条，标号=源记录号+后缀（+=超分 −=去字幕） */
export interface VideoDerivedRecord {
  id: string;
  kind: "upscale" | "desub";
  /** 处理结果（本地 localUri）。API 接入前为源视频原样占位 */
  uri: string;
  /** 实际处理输入 uri（=处理时选中记录的产物，链式允许：对 v1+ 去字幕输入的是超分后的 720 版） */
  srcUri: string;
  /** 处理输入记录的标号（如 v1 / v1+，展示用） */
  srcLabel?: string;
  /** 显示标号：恒为 v{n}+ / v{n}-（单后缀，取决于最后一次处理；n=链条根记录号）。同标号唯一，后到覆盖 */
  label: string;
  createdAt: number;
  /** 处理参数（分辨率/擦除模式/局部擦除框等，发往火山 MediaKit） */
  params?: Record<string, unknown>;
  /** 处理中/失败态（成功后清除；uri 有值即可用） */
  status?: "running" | "failed";
  error?: string;
  /** 生效模型（如 volc-enhance-fast；展示与重试用） */
  modelKey?: string;
}

/** 单分镜的局部覆盖（未设置项回退「视频设置」全局值）——提示词区展开面板可逐分镜设置 */
export interface ShotOverrides {
  sbPromptTplId?: string;   // 故事板提示词模板
  videoPromptTplId?: string; // 视频提示词模板
  videoModelKey?: string;   // 视频模型（catalog 模型 id）
  duration?: number;        // 视频时长(秒)
  aspect?: string;          // 视频比例 16:9 | 9:16 | 1:1
  resolution?: string;      // 视频分辨率 480p | 720p | 1080p
  /** 生成方法（第131轮）：omni=全能参考 / frames=首尾帧（仅声明了 methods 的模型有效） */
  method?: string;
  /** 旧版兼容字段：素材区图片的人像用途 0 基下标；新版以 ShotMaterial.usage 为准。 */
  officialAssetIndexes?: number[];
}

/** 单个分镜（一行大分镜 ≈ 15s 视频镜头） */
export interface StoryboardShot {
  id: string;
  index: number;
  title: string;            // 分镜1（补镜头为「分镜3-1」这类派生编号，见 isSupplement）
  /** 原文拆分：本大分镜对应的原始剧本文本（智能拆分 verbatim 产出；向上/下拆按换行行迁移） */
  scriptSegment?: string;
  prompt: string;           // 旧版单一提示词（兼容保留；新流程用 storyboardPrompt/videoPrompt）
  /** 故事板提示词（推理产出，喂图像模型） */
  storyboardPrompt?: string;
  /** 视频提示词（推理产出，喂视频模型） */
  videoPrompt?: string;
  /** 图视同源提示词（推理产出，图片与视频共用同一段；仅项目「图视同源」模式使用） */
  unifiedPrompt?: string;
  /** 推理产出时的故事板/视频/同源提示词基线（用户编辑后据此高亮更改，便于检查；用户手改后不变） */
  storyboardPromptBase?: string;
  videoPromptBase?: string;
  unifiedPromptBase?: string;
  durationSec?: number;     // 该分镜时长（秒），从模型输出解析
  materials: ShotMaterial[];
  storyboardUri?: string;   // 主故事板图（本地 localUri，图像模型产出）
  storyboardImages?: string[]; // 故事板历史记录（本地 localUri）
  videoUri?: string;        // 主视频（本地 localUri，视频模型产出）
  videoUris?: string[];     // 视频历史记录（本地 localUri）
  /** 视频处理派生记录（超分/去字幕），与 videoUris 并列显示在视频区历史条 */
  videoDerived?: VideoDerivedRecord[];
  /** 故事板图处理派生记录（图像超分），与 storyboardImages 并列显示在故事板历史条（复用同一记录结构） */
  sbDerived?: VideoDerivedRecord[];
  /** 当前主视频对应的记录标识：`u:<uri>`（videoUris 里的原始记录）或 `d:<id>`（videoDerived 派生记录）。
   *  占位阶段派生记录与源是同一 uri，仅凭 videoUri 无法区分选中的是哪条——靠它精确高亮/回溯源标号；
   *  与 videoUri 对不上时（如新生成视频直接改了 videoUri）自动失效回退 uri 比较。 */
  videoActiveKey?: string;
  /** 补镜头：编号派生自上一个主镜号（如上一镜「分镜3」→ 本镜「分镜3-1」），影响命名/导出 */
  isSupplement?: boolean;
  /** 单分镜局部覆盖（模板/模型/参数）；未设置回退全局视频设置 */
  overrides?: ShotOverrides;
}

/** 视频/分镜界面的「视频设置」——逐项目持久化（重启不回默认） */
export interface MediaSettings {
  /** 剧集拆分方式（第243轮，新建项目可预设）：快拆 __quick_* id（见 lib/splitChoices）或 catalog「剧集」类模板 id；空=默认 快速·n-n */
  episodeTplId?: string;
  /** 资产拆分模板 id（script.analyze，第243轮起持久化；空=catalog 默认款 isDefault） */
  assetExtractTplId?: string;
  /** 拆分 */
  splitTplId?: string;
  /** 智能推理提示词模板 id（多卡，storyboard.toVideoPrompt；空=多分镜默认模板） */
  inferTplId?: string;
  /** 单卡推理提示词模板 id（storyboard.singleShot；空=单卡默认模板）——单镜按键/一键单卡用 */
  singleTplId?: string;
  /** 图视同源模式：开启后故事板/视频用同一段「同源提示词」，提示词区单栏、图片与视频共用；
   *  推理走同源模板、同步到画布走同源链路（原文→图片+视频并联）。 */
  imgVideoSameSource?: boolean;
  /** 图视同源·多卡 推理模板 id（storyboard.unified；空=同源多卡默认模板） */
  unifiedTplId?: string;
  /** 图视同源·单卡 推理模板 id（storyboard.unifiedShot；空=同源单卡默认模板）——单镜按键/一键单卡用 */
  unifiedSingleTplId?: string;
  maxDuration?: number;     // 单镜最大时长(秒)
  shotCount?: number;       // 0=自动
  /** 故事板图像 */
  sbPromptTplId?: string;
  imageAspect?: string;     // "16:9" | "9:16" | "1:1"
  imageResolution?: string; // "1K" | "2K" | "4K"
  imageQuality?: string;    // "low" | "medium" | "high" | "auto"
  /** 视频 */
  videoPromptTplId?: string;
  resolution?: string;      // "480p" | "720p" | "1080p"
  aspect?: string;          // "16:9" | "9:16" | "1:1"
  /** 生成方法全局默认（第131轮）：omni=全能参考 / frames=首尾帧；单镜可在提示词区覆盖 */
  videoMethod?: string;
  genWithAsset?: boolean;
  genWithStory?: boolean;
}

/**
 * 界面快照（逐项目持久化）：记录「用户上次停留在哪一页 / 哪一集 / 选中哪个资产 / 滑到哪里」，
 * 重开软件或项目时恢复，做到「和上次关闭时一样」。仅 UI 位置信息，不含业务数据。
 */
export interface UiSnapshot {
  /** 上次停留的路由（pathname）——同时决定 表格/画布模式 与 侧栏 tab（皆由路由派生） */
  route?: string;
  /** 资产页（角色/场景/生物/物品/群像，共用 AssetWorkbench）选中态，按资产类型分键 */
  assetPages?: Partial<Record<"characters" | "scenes" | "items" | "organisms" | "crowds", {
    selectedId?: string;        // 选中的资产实体 id
    selectedFormKey?: string;   // 选中的造型/分体（"base" 或变体 id）
    searchQuery?: string;       // 列表搜索词
    listScrollTop?: number;     // 资产列表滚动位置
  }>>;
  /** 视频/分镜界面 */
  video?: {
    episodeId?: string;                                  // 选中分集
    promptTab?: Record<string, "storyboard" | "video">;  // 各分镜的提示词 tab
    tableScrollTop?: number;                             // 分镜表格滚动位置
    episodeListScrollTop?: number;                       // 分集列表滚动位置
  };
}

/** 分集（视频界面左侧列表项），含本集剧本与其分镜 */
export interface VideoEpisode {
  id: string;
  index: number;
  title: string;            // 001-剧集标题
  scriptText: string;       // 本集剧本内容
  shots: StoryboardShot[];
}

export interface QijiProject {
  version: string;
  name: string;
  savedAt: string;
  head: string;
  commits: Record<string, CommitSnapshot>;
  files: Record<string, string | null>;
  /** 迁移日志，记录版本升级历史 */
  migrationLog?: MigrationLogEntry[];
  scriptText?: string;
  visualStyle?: string;
  /** 新建项目所选画风预设 id（第174轮；决定资产拆分自动附加的【画风前缀】胶囊；空=兜底画风/旧项目，不挂） */
  visualStyleId?: string;
  /** 项目视觉圣经：全局风格 / 全局色调 / 全局禁用词（资产提取产出） */
  visualBible?: { style: string; colorSystem: string; negativeGlobal: string };
  /** 项目封面缩略图（data URL，新建时上传，已压缩） */
  coverImage?: string;
  /* 音色字段（voiceUri/voiceAssetId/voiceName）五类均可选：资产模式绑音色仅角色，
     画布「音频绑定到资产」（第113轮）对五类开放——匹配资产时随资产加入声音参考并进图例配对 */
  characters?: Array<{ id: string; name: string; features: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  scenes?: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  items?: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  organisms?: Array<{ id: string; name: string; description: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  crowds?: Array<{ id: string; name: string; features: string; philosophy: string; prompt: string; image?: string; images?: string[]; variants?: AssetVariantLite[]; voiceUri?: string; voiceAssetId?: string; voiceName?: string }>;
  isAnalyzed?: boolean;
  analysisTime?: string;
  /** LibTV 云端画布 UUID（Seedance 2.0 CLI 生成的落点；首次生成时自动 project create，随项目持久化） */
  libtvCanvasUuid?: string;
  /** 在途生成任务（断连保护），持久化随项目 */
  pendingGens?: PendingGen[];
  /** 在途「智能推理」任务（断连保护 + 锁定），持久化随项目 */
  inferTasks?: InferTask[];
  /** 在途剧本分析任务（断连保护）：关客户端后重开凭 taskId 重连服务端取结果 */
  analysisTask?: { taskId: string; adapterKey: string; kind: "analyze" | "continue"; startedAt: number } | null;
  /** 资产二进制三元映射：assetId ↔ 公网url ↔ 本地路径（随项目持久化） */
  assetBlobs?: Record<string, AssetBlob>;
  /** 视频/分镜：分集列表（每集含本集剧本 + 分镜 + 垫素材 + 故事板/视频产物） */
  episodes?: VideoEpisode[];
  projectModelConfig?: ProjectModelConfig;
  /** 视频/分镜界面的「视频设置」（逐项目持久化） */
  mediaSettings?: MediaSettings;
  /** 界面快照：上次停留的页/集/选中资产/滚动位置（重开恢复） */
  uiSnapshot?: UiSnapshot;
  /** 各生成图的请求详情（出图提示词 + 垫图），按图片 uri 存，供展示区「详情」回看 */
  genMeta?: Record<string, GenMeta>;
  /** 记忆的垫图：按 `${cat}:${assetId}:${formKey}` 存，切换造型/资产回来仍在 */
  assetRefImages?: Record<string, RefImgMemo[]>;
  /** Legacy v1.x 顶层字段（兼容旧格式读取） */
  nodes?: Record<string, CanvasNode>;
  edges?: Record<string, CanvasEdge>;
  groups?: Record<string, CanvasGroup>;
  viewport?: { x: number; y: number; zoom: number };
  assets?: Record<string, import("@/store/libraryStore").Asset>;
  canvas?: CommitSnapshot["canvas"];
  /** 实时剪辑（第三模式）文档：轨道→片段（素材时间窗口引用，微秒时间基）。
   *  只存 assetId/uri 引用绝不内嵌字节；缺省=项目未用过实时剪辑（不 bump 版本、无迁移，与全部可选字段同做法）。
   *  ⚠ 分集化后为**旧字段**（只读兼容）：加载时迁移进 rtcDocs 第一集，保存不再写它。 */
  rtcDoc?: RtcDoc;
  /** 实时剪辑按分集分档（一个分集 = 一条独立时间轴，key=分集 id；与 canvases 同构） */
  rtcDocs?: Record<string, RtcDoc>;
  /** 实时剪辑当前激活分集 id（缺省/失效=第一集，resolveEpisodeKey 同画布规则） */
  rtcEpisodeId?: string;
  /** 多画布：一个项目 = 一个资产模式 + 多块独立画布（key=分集 id，"__main__"=无分集的主画布）。
   *  每块画布有各自的节点/连线/分组/视口，互不影响；当前激活画布存 activeCanvasKey。 */
  canvases?: Record<string, CanvasData>;
  activeCanvasKey?: string;
}

/** 单块画布的完整数据（多画布架构：每个分集一块） */
export interface CanvasData {
  nodes: Record<string, CanvasNode>;
  edges: Record<string, CanvasEdge>;
  groups: Record<string, CanvasGroup>;
  viewport?: { x: number; y: number; zoom: number };
}

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

async function getTauriFs() {
  const { writeTextFile, readTextFile } = await import("@tauri-apps/plugin-fs");
  const { save, open } = await import("@tauri-apps/plugin-dialog");
  const { documentDir, join } = await import("@tauri-apps/api/path");
  return { writeTextFile, readTextFile, save, open, documentDir, join };
}

/**
 * 版本迁移注册表：从 v1.x 到 v2.0 的迁移函数
 */
interface MigrationFunction {
  (project: any): any;
}

const migrations: Record<string, MigrationFunction> = {
  // v1.x -> v2.0: 引入 commits 历史快照结构
  "1.x-to-2.0": (oldProj: any) => {
    const initialCommitId = "commit-init";
    const initialCommit: CommitSnapshot = {
      commitId: initialCommitId,
      parentIds: [],
      message: "从 v1.x 迁移",
      author: "System",
      timestamp: oldProj.savedAt || new Date().toISOString(),
      canvas: oldProj.canvas || {
        nodes: oldProj.nodes || {},
        edges: oldProj.edges || {},
        groups: oldProj.groups || {},
        viewport: oldProj.viewport || { x: 0, y: 0, zoom: 1 },
      },
      assets: oldProj.assets || {},
    };

    return {
      version: "2.0",
      name: oldProj.name || "未命名项目",
      savedAt: oldProj.savedAt || new Date().toISOString(),
      head: initialCommitId,
      commits: { [initialCommitId]: initialCommit },
      files: oldProj.files || {},
      migrationLog: [
        {
          fromVersion: oldProj.version || "1.x",
          toVersion: "2.0",
          migratedAt: new Date().toISOString(),
          description: "引入 commits 历史快照结构，支持版本回滚",
        },
      ],
    };
  },
};

/**
 * 迁移兼容：将旧版本项目数据平滑转化为最新版本结构
 */
export function migrateProject(oldProj: any): QijiProject {
  // 如果已经是 v2.0+ 且包含 commits，直接返回
  if (oldProj.commits && oldProj.head && oldProj.version === "2.0") {
    return oldProj as QijiProject;
  }

  // 检查版本号并执行对应迁移
  const version = oldProj.version || "1.x";

  // v1.x -> v2.0
  if (version.startsWith("1") || !oldProj.commits) {
    const migrated = migrations["1.x-to-2.0"](oldProj);
    return migrated;
  }

  // 未知版本，尝试作为 v2.0 处理
  return {
    version: Qiji_VERSION,
    name: oldProj.name || "未命名项目",
    savedAt: oldProj.savedAt || new Date().toISOString(),
    head: oldProj.head || "commit-init",
    commits: oldProj.commits || {},
    files: oldProj.files || {},
    migrationLog: oldProj.migrationLog || [],
  };
}

/**
 * 记录迁移日志
 */
export function addMigrationLog(
  project: QijiProject,
  fromVersion: string,
  toVersion: string,
  description: string,
): QijiProject {
  const log: MigrationLogEntry = {
    fromVersion,
    toVersion,
    migratedAt: new Date().toISOString(),
    description,
  };

  return {
    ...project,
    migrationLog: [...(project.migrationLog || []), log],
  };
}

/**
 * 将 QijiProject 序列化为 JSON 写入磁盘或触发浏览器下载。
 */
export async function saveProject(
  project: QijiProject,
  existingPath?: string | null,
): Promise<string | null> {
  project.version = Qiji_VERSION;
  project.savedAt = new Date().toISOString();
  const json = JSON.stringify(project, null, 2);

  if (isTauri()) {
    const { writeTextFile, save, documentDir, join } = await getTauriFs();

    let filePath = existingPath;
    if (!filePath) {
      const defaultPath = await join(await documentDir(), "Qiji", `${project.name}${FILE_EXT}`);
      filePath = await save({
        defaultPath,
        filters: [{ name: "Qiji 项目", extensions: ["Qiji"] }],
      }) as string | null;
    }
    if (!filePath) return null;

    await writeTextFile(filePath, json);
    return filePath;
  }

  // 浏览器降级：触发 JSON 下载
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${project.name}${FILE_EXT}`;
  a.click();
  URL.revokeObjectURL(url);
  return null;
}

/**
 * 弹出文件对话框，读取并解析 .Qiji 项目文件，自动做版本兼容迁移。
 */
export async function openProject(): Promise<{ project: QijiProject; path: string } | null> {
  if (isTauri()) {
    const { readTextFile, open } = await getTauriFs();
    const selected = await open({
      multiple: false,
      filters: [{ name: "Qiji 项目", extensions: ["Qiji"] }],
    }) as string | null;
    if (!selected) return null;
    const json = await readTextFile(selected);
    const parsed = JSON.parse(json);
    return { project: migrateProject(parsed), path: selected };
  }

  // 浏览器降级：<input type=file>
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = FILE_EXT + ",application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string);
          resolve({ project: migrateProject(parsed), path: file.name });
        } catch {
          resolve(null);
        }
      };
      reader.readAsText(file);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * 直接从指定路径读取项目（启动时恢复上次项目），自动做版本兼容迁移。
 */
export async function loadProjectFromPath(path: string): Promise<QijiProject | null> {
  if (!isTauri()) return null;
  try {
    const { readTextFile } = await getTauriFs();
    const json = await readTextFile(path);
    const parsed = JSON.parse(json);
    return migrateProject(parsed);
  } catch {
    return null;
  }
}
