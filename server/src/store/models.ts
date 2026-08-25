/**
 * 模型存储（文件持久化）—— 数据化的 catalog 模型 + 翻译格式。
 *
 * 每个模型带 protocol（决定走哪个翻译器）+ 上游覆盖（baseUrl/apiKey/upstreamModel）。
 * 管理端可自定义加载第三方模型、查看/编辑翻译格式。改动后 bump catalog 版本。
 */
import { loadJson, saveJson } from "./db.ts";
import { CH_GAISC, CH_JIANMENG, CH_VOLC, CH_SUDASHUI, CH_AISTARS, CH_HUAYING, CH_DIMENSIO, CH_AIVIDE, CH_JIANMENGP, CH_MUSEM, CH_JMZ, CH_JMH, CH_YUNWU, CH_JMT, CH_JMF, CH_OVERSEAS, CH_SUANLI, CH_YALI_OPENAI, CH_YALI_GEMINI, CH_SKYLEE, CH_CONGGE, CH_AUTODL, CH_QIJICLOUD, CH_BYS, CH_QIQI } from "./channels.ts";
import { audienceChain, agentModelBlocked, audienceGroupId } from "./agents.ts";
import { normMatLimits, type MatLimits } from "../materialLimits.ts";
import type { ParamField, Capability } from "../contract.ts";

/** 翻译协议：决定 dispatch 路由到哪个翻译器 */
export type Protocol =
	| "echo"
	| "openai-chat"
	| "anthropic-messages"
	| "openai-image"
	| "gemini-image"
	| "jianmeng-video"
	| "openai-video"
	| "volc-mediakit"
	| "sudashui-video"
	| "aistars-video"
	| "huaying-video"
	| "dimensio-video"
	| "aivide-video"
	| "jianmengp-video"
	| "musem-video"
	| "jmz-video"
	| "jmz-image"
	| "jmt-video"
	| "jmf-video"
	| "overseas-video"
	| "suanli-video"
	| "aistars-image"
	| "jmh-image"
	| "jmh-video"
	| "yali-image"
	| "skylee-image"
	| "congge-image"
	| "congge-video"
	| "autodl-video"
	| "qijicloud-comfy"
	| "bys-video"
	| "qiqi-video"
	| "stub";

/**
 * 重定向规则：同一逻辑模型按请求参数选用不同真实上游模型。
 * 例：seedance 2.0 在 480p / 720p 实际调用的上游模型名不同。
 *  - when：参数匹配条件（全部命中才生效），值按字符串比较（如 { quality: "480p" }）。
 *  - upstreamModel：命中时发给上游的真实模型名。
 *  - channelId：可选，命中时改用另一渠道的凭据（不填沿用模型/默认渠道）。
 */
export interface ModelRoute {
	when: Record<string, string>;
	upstreamModel: string;
	channelId?: string;
	/** 命中该规则时的积分（不同档位价不同，如 480p≠1080p）；不填用模型基准 cost */
	cost?: number;
	/** 命中该规则时的「每单位价」（配合模型 costField，不同档位每秒价不同）；不填用模型 costPerUnit */
	costPerUnit?: number;
}

export interface ModelDef {
	id: string;
	label: string;
	capability: Capability;
	protocol: Protocol;
	/** 归属渠道（提供 baseUrl + apiKey）；不填走网关默认或下方 baseUrl/apiKey 覆盖 */
	channelId?: string;
	/** 发给上游的真实模型名（默认 = id） */
	upstreamModel?: string;
	/** 按请求参数重定向到不同真实上游模型（命中优先于 upstreamModel） */
	routes?: ModelRoute[];
	/** 上游地址覆盖（优先级最高，默认走渠道 / 网关） */
	baseUrl?: string;
	/** 上游密钥覆盖（优先级最高，默认走渠道 / 网关 key）；管理端列表中脱敏 */
	apiKey?: string;
	params: ParamField[];
	/** 基准积分（固定/起步价；未配置按字段计费时即为单次扣费） */
	cost: number;
	/**
	 * 按字段计费：填某个参数键（如视频的 "duration"）后，本次扣费 = 每单位价 × 该字段值。
	 * 空 = 不按字段计费，沿用 cost / 路由 cost。
	 */
	costField?: string;
	/** 每单位价（配合 costField，如视频每秒积分）；路由可覆盖（costPerUnit） */
	costPerUnit?: number;
	/** 内部模型：不进 catalog 下发（客户端模型下拉不可见），但 /v1/generate 仍可按 id 调用并计费。
	 *  用途：第三方本地渠道（LibTV/即梦）手续费——客户端在第三方调用成功后请求该虚拟模型扣费。 */
	hidden?: boolean;
	/** 对哪些受众开放（第110轮，与模板 shareScope 同构；受众=各渠道商 + 源站 PLATFORM_AUDIENCE）：
	 *  "all"（默认/未设）=全部开放；"select"=仅 shareAgentIds 列出的受众；"none"=不开放给任何人。
	 *  不开放的受众：catalog 不下发该模型，/v1/generate 调用被拒（403）。 */
	shareScope?: "all" | "select" | "none";
	/** shareScope==="select" 时开放到的受众 id 列表（渠道商 id / "platform"=源站）。
	 *  ⚠ 第167轮起为**旧清单**（存量数据仍生效）：管理端「开放范围」已改按分组勾选（shareGroupIds），
	 *  保存时会清空本字段。 */
	shareAgentIds?: string[];
	/** shareScope==="select" 时开放到的**渠道商分组** id 列表（第167轮，agent-groups 注册表）：
	 *  受众（渠道商/源站）的生效分组命中即开放（链上任一受众命中同旧语义）。后期商多了按组管理。 */
	shareGroupIds?: string[];
	/** 归属模式（第130轮，modes.json 注册表的 id）：无=默认模式（常开、不可禁）；
	 *  有=用户/渠道商可按 features.modes[modeId] 启用禁用（关=客户端隐藏 + generate/batch 403）。 */
	modeId?: string;
	/** 归属家族（第163轮，families.json 注册表的 id）：底层模型种类（Seedance 2.0/Sora2/GPT Image 2…），
	 *  **纯展示分组**——客户端模型选择四级「家族→渠道/线路→模型→要求」的一级筛选；无=归入「其他」。
	 *  与 modeId 分工：模式=渠道源头+门禁开关（第二级显示名/关渠道用它），家族不参与门禁/计费。
	 *  归类一把尺 classifyFamily（种子/迁移/新建缺省共用）；管理端「模型」页可改。 */
	familyId?: string;
	/** 支持的生成「方法」（第131轮，视频模型）：omni=全能参考 / frames=首尾帧；缺省=仅全能参考。
	 *  客户端按此渲染「方法」级下拉，提交时落 params.method（翻译器按 method 组不同 payload）。 */
	methods?: string[];
	/** 支持官方真人素材库（苏打水 gf 系专属）：客户端提供「真人图 1-9 多选」→ params.officialAssetIndexes（0 基）。 */
	officialAssets?: boolean;
	/** 参考视频按秒计费折算系数（第140轮，按秒视频模型专用）：计费秒数 = duration + 系数 × Σceil(每条参考视频秒)
	 *  （不足1秒算1秒，逐条向上取整）。缺省/0=参考视频不计费；1=与出片每秒价同价（用户定，Dimensio dm 系种子=1）。
	 *  仅对配了 costField 的按秒模型生效；时长服务端探测（refVideoBilling.ts），读不出时长明确拒单。 */
	refVideoSecondsWeight?: number;
	/** 素材数量上限（第145轮，管理端可调，materialLimits.ts）：图/视/音 各自上限；键缺省=不限、0=不允许该类素材
	 *  （如 933 收紧为 903 即「vid:0」禁垫视频）。generate/batch 硬闸（超限明确拒单）+ catalog 下发供客户端预检。
	 *  语义=只能收紧（翻译器/上游能力表仍是最后一道闸）。⚠ 管理端自有配置：不入 MODEL_REFRESH_FIELDS（seed 刷新不冲掉）。 */
	matLimits?: MatLimits;
	/** 模型备注（第166轮，管理端「模型」页可编辑）：**会经 catalog 下发给用户**（客户端悬浮积分图标显示），
	 *  勿写接入信息/上游线路等敏感内容。未设=客户端默认显示参考素材上限（matLimits 派生文案）。
	 *  ⚠ 管理端自有配置：不入 MODEL_REFRESH_FIELDS（seed 刷新不冲掉）。 */
	note?: string;
	/** 组内显示顺序（第176轮，管理端「模型」页拖动排序）：**影响客户端下拉顺序**——
	 *  catalog 排序键 = 模式 order → 本字段 → 原始加入序（同模式内按它排，跨模式仍以模式序为先）。
	 *  未设=排在同组已排过的之后（首次拖动会把全表压实成 1..n）。
	 *  ⚠ 管理端自有配置：不入 MODEL_REFRESH_FIELDS（seed 刷新不冲掉）。 */
	order?: number;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

interface Store {
	version: number;
	/** 内置模型种子版本：bump 后启动时一次性"退役清理 + 刷新内置定义"（见 RETIRED_IDS / MODELS_SEED_VERSION） */
	seedVersion?: number;
	models: ModelDef[];
	/** 已被管理员删除的内置模型 id（墓碑）——重启时不再补种，使删除可持久 */
	deletedSeedIds?: string[];
	/** 定向迁移版本（第122轮）：视频超分 resolution 收敛 720p-only（只动该字段，不整模型刷新） */
	volcResVersion?: number;
	/** 定向迁移版本（第130轮）：给存量 seedance 视频模型补 modeId="qiji"（只动该字段，不整模型刷新） */
	modeInitVersion?: number;
	/** 定向迁移版本（第140轮）：Dimensio dm 系存量模型补 refVideoSecondsWeight=1（参考视频与出片同价按秒计费） */
	refVideoBillVersion?: number;
	/** 定向迁移版本（第148轮）：星辰全面换线 48/50/51（删 10 旧线模型进墓碑 + 强制刷新保留 4 个 + 补种 2 新模型） */
	xcRefreshVersion?: number;
	/** 定向迁移版本（第149轮）：苏打水按上游清单更新（删 6 死链进墓碑 + 存量上架 + 只补缺 matLimits + 补种 16 新模型） */
	sdsRefreshVersion?: number;
	/** 定向迁移版本（第156轮）：苏打水收编 26→7（删 19 进墓碑）+ 三模式（jmgf/jm431/jm933）合一归入「简梦S」（jms） */
	sdsConsolidateVersion?: number;
	/** 定向迁移版本（第159轮）：简梦P 按 2026-07 文档清单删 veo31/veo31-ref 进墓碑（补 gemini-omni-flash 走补种） */
	jmpTrimVersion?: number;
	/** 定向迁移版本（第162轮）：星辰 50 线 fast 素材放宽 900→933 → xc900-sd2.0-fast-c 改名删旧进墓碑
	 *（新 id xc933-sd2.0-fast-c 走补种；53 漫剧优选线 2 模型与图片线 4 模型同走补种） */
	xc50RenameVersion?: number;
	/** 定向迁移版本（第163轮）：给全部存量模型按 classifyFamily 补 familyId（只补缺不覆盖，一次性） */
	familyInitVersion?: number;
	/** 定向迁移版本（第187轮）：os933-sd2.5 时长上限 15→30（sd-2-5 支持 30s）+ 兜底价按最高档修正 */
	osSd25DurVersion?: number;
	/** 定向迁移版本（第216轮）：星辰按 2026-08-09 config 对齐存量能力（grok 两款大改/48 线 frames 下线/
	 *  50 线 sd2.0 时长放宽/比例档更新）——全部守卫式只改「仍为旧种子值」的字段，不冲管理端改动；
	 *  新 11 视频+1 图片模型走 ③ 补种 */
	xcCaps216Version?: number;
	/** 定向迁移版本（第242轮）：简梦P 按 2026-08 新版文档（api.pixellelabs.com）收敛——v1 删 Sora 系 4 款进墓碑
	 *  （新 H3video-2k 走 ③ 补种）；v2（同轮补充，用户令恢复 gemini-omni-flash/veo31-fast）：对已跑过首版 v1
	 *  （曾删 6 款）的库出墓碑+定向补种这两款 */
	jmpH3Version?: number;
}

const FILE = "models.json";

const TEXT_PARAMS: ParamField[] = [
	{ key: "temperature", label: "温度", type: "number", default: 0.7, min: 0, max: 2, step: 0.1 },
	{ key: "maxTokens", label: "最大长度", type: "number", default: 2048, min: 1, max: 8192, step: 256, unit: "tokens" },
];
const IMG_SIZE: ParamField = {
	key: "size",
	label: "尺寸",
	type: "enum",
	options: ["1024x1024", "2048x2048", "3840x2160", "2160x3840"],
	default: "1024x1024",
};
/**
 * 生图分辨率档 —— 客户端「分辨率」下拉的**服务端开关**：options 放哪些档（1k/2k/4k）客户端就显示哪些
 * （资产五页/视频页故事板图/画布图片节点共用；管理端「模型→参数」改 options 即热更生效，零发版）。
 * 上游按画质映射定实际分辨率、档位不完全受控，故缺省只开 2k；模型未声明本参数时客户端回退内置 2K。
 */
const IMG_RESOLUTION: ParamField = {
	key: "resolution",
	label: "分辨率档",
	type: "enum",
	options: ["2k"],
	default: "2k",
};
function def(
	id: string,
	label: string,
	capability: Capability,
	protocol: Protocol,
	params: ParamField[],
	cost: number,
	extra?: Partial<ModelDef>,
): ModelDef {
	const now = new Date().toISOString();
	return { id, label, capability, protocol, params, cost, enabled: true, createdAt: now, updatedAt: now, ...extra };
}

/**
 * Seedance 2.0：拆成「专业(pro)」与「快速(fast)」两个用户可见模型，各自只暴露 resolution 一个选择项，
 * 按分辨率重定向到真实上游模型名（用户端无需知道真名）。计费随档位。真名/价见 资料/简梦JA渠道对接(1).md。
 *  - fast 仅 480p/720p（按秒计费档）；pro 含 480p/720p/1080p（1080p 为按次 15s 固定）。
 */
const seedanceParams = (resolutions: string[]): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: resolutions, default: "720p" },
	{ key: "duration", label: "时长（1080p 固定 15s）", type: "number", default: 15, min: 4, max: 15, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1", "21:9", "3:4", "4:3"], default: "16:9" },
];
// 视频按时长计费：每档分辨率有不同「每秒价」(costPerUnit)，本次扣费 = 每秒价 × duration(秒)。
// 例：pro 720p 每秒 3 分 × 15 秒 = 45 分。cost 仍留作兜底（duration 缺省/为 0 时用）。
const SEEDANCE_PRO_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "JA-sd2-pro-480", cost: 30, costPerUnit: 2 },
	{ when: { resolution: "720p" }, upstreamModel: "JA-sd2-pro-720", cost: 45, costPerUnit: 3 },
	{ when: { resolution: "1080p" }, upstreamModel: "JA-sd2-pro-1080p", cost: 90, costPerUnit: 6 },
];
const SEEDANCE_FAST_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "JA-sd2-fast-480", cost: 20, costPerUnit: 1.5 },
	{ when: { resolution: "720p" }, upstreamModel: "JA-sd2-fast-720", cost: 30, costPerUnit: 2 },
];

// ── 火山引擎 AI MediaKit（视频超分/去字幕）参数（按官方文档；video_url 由 inputs.videos[0] 提供，不在此列）──
// 第122轮收紧（用户定，费用失控事故后）：视频超分目标分辨率**一律只开 720p**（1080p/2k/4k 上游费用过高）；
// 码率档位/输出编码不开放选择——bitrate_level 不发=走上游默认（撤销第90轮"固定 high"），output_encode_mode 走上游默认 Quality（volc.ts）。
// 要临时开放高档：管理端「模型→参数」给 resolution.options 加档即可（catalog 热更下拉 + 服务端 clamp 同步放行）。
// ⚠ seed bump 会用种子整体覆盖管理端的 params 改动（v6 就曾把收紧过的档位刷回四档全开=本次事故根源之一）——
//    后续 bump 前先确认生产管理端是否有需保留的参数改动。
const VOLC_RES_720: ParamField = { key: "resolution", label: "目标分辨率", type: "enum", options: ["720p"], default: "720p" };
/** 输出帧率（API 支持 [15,120]；发上游前 volc.ts 转数值） */
const VOLC_FPS: ParamField = { key: "fps", label: "帧率", type: "enum", options: ["30", "60", "120"], default: "30", unit: "fps" };
/** 大模型（Diffusion 生成式） */
const VOLC_ENHANCE_GEN_PARAMS: ParamField[] = [VOLC_RES_720, VOLC_FPS];
/** 极速版 */
const VOLC_ENHANCE_FAST_PARAMS: ParamField[] = [VOLC_RES_720, VOLC_FPS];
/** 标准版：带场景（仅标准版生效） */
const VOLC_ENHANCE_STD_PARAMS: ParamField[] = [
	{ key: "scene", label: "场景", type: "enum", options: ["common", "ugc", "short_series", "aigc", "old_film"], default: "aigc" },
	VOLC_RES_720,
	VOLC_FPS,
];
/** 专业版 */
const VOLC_ENHANCE_PRO_PARAMS: ParamField[] = [VOLC_RES_720, VOLC_FPS];
/** 字幕擦除（精细化版）：擦除范围（全屏/局部画框 erase_ratio_location）由客户端弹窗提供，不在 catalog 参数 */
const VOLC_ERASE_PARAMS: ParamField[] = [
	{ key: "mode", label: "擦除模式", type: "enum", options: ["Subtitle", "Text"], default: "Subtitle" },
];
/** 图像画质增强（同步接口）：目标（倍率/长边分辨率→multiple）由客户端弹窗按源图尺寸换算，不在 catalog 参数 */
const VOLC_IMG_ENHANCE_PARAMS: ParamField[] = [
	{ key: "tool_version", label: "增强版本", type: "enum", options: ["standard", "professional", "max"], default: "professional" },
];

// ── 苏打水（简梦）Seedance 2.0 家族（第131轮接入；第149轮按 2026-07-22 上游 /v1/models 全量更新）──────
// 26 个外显模型 = 上游 37 个视频 id 收敛（jy 图片 3 个用户定暂不接；分辨率后缀由「要求」经 routes 重定向）。
// 分三个模式：jmgf（gf 官方真人库 + gf2 豆包二线）/ jm431（hn+pd）/ jm933（bf+mo+ld+wf+xh+pd+xinghe）。
// 方法（methods）：seedance 系全支持 全能参考(omni)+首尾帧(frames)；xinghe 家族未知→不声明（仅全能参考）。
// 时长：hn 上游只收 5/10/15 三档（enum），其余 4-15 连续；比例含 adaptive。
// matLimits：933={9,3,3}、431={4,3,1}、gf={9,0,3}（上游拒视频）；gf2/xinghe 能力未知不设（报错优于编造，上游兜底）。
const SUDASHUI_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"];
const SDS_933 = { img: 9, vid: 3, aud: 3 };
const SDS_431 = { img: 4, vid: 3, aud: 1 };
const SDS_GF = { img: 9, vid: 0, aud: 3 };
const sudashuiParams = (resolutions: string[], hnDuration = false): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: resolutions, default: resolutions[0] },
	hnDuration
		? { key: "duration", label: "时长", type: "enum", options: ["5", "10", "15"], default: "15", unit: "s" }
		: { key: "duration", label: "时长", type: "number", default: 15, min: 4, max: 15, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: SUDASHUI_ASPECTS, default: "16:9" },
];
/** gf903-sd2.0 按分辨率重定向到四个上游真名（价格为占位价，管理端可调） */
const GF903_ROUTES: ModelRoute[] = [
	{ when: { resolution: "720p" }, upstreamModel: "sdas-gf-seedance-2.0-720p", cost: 45, costPerUnit: 3 },
	{ when: { resolution: "1080p" }, upstreamModel: "sdas-gf-seedance-2.0-1080p", cost: 68, costPerUnit: 4.5 },
	{ when: { resolution: "2k" }, upstreamModel: "sdas-gf-seedance-2.0-2k", cost: 90, costPerUnit: 6 },
	{ when: { resolution: "4k" }, upstreamModel: "sdas-gf-seedance-2.0-4k", cost: 135, costPerUnit: 9 },
];
// ── wf 线 933 多档 routes（第149轮；占位价；兜底=每秒价×15，第134轮规则。gf2/pd431 等旧线 routes 随
//    第156轮苏打水收编 26→7 一并移除——需要时按 git 历史恢复或管理端重建）──
/** wf 线 933：pro 三档（含 1080p）/ fast 两档 */
const WF933_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "sdas-wf-sd2.0-pro-933-480p", cost: 23, costPerUnit: 1.5 },
	{ when: { resolution: "720p" }, upstreamModel: "sdas-wf-sd2.0-pro-933-720p", cost: 30, costPerUnit: 2 },
	{ when: { resolution: "1080p" }, upstreamModel: "sdas-wf-sd2.0-pro-933-1080p", cost: 45, costPerUnit: 3 },
];
const WF933_FAST_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "sdas-wf-sd2.0-fast-933-480p", cost: 15, costPerUnit: 1 },
	{ when: { resolution: "720p" }, upstreamModel: "sdas-wf-sd2.0-fast-933-720p", cost: 23, costPerUnit: 1.5 },
];
/** 苏打水模型简写工厂：外显 id=label，按秒计费占位价（cost 兜底 / costPerUnit 每秒），管理端可改计费方式 */
const sds = (id: string, upstream: string, modeId: string, opts?: { hn?: boolean; res?: string[]; perUnit?: number; cost?: number; extra?: Partial<ModelDef> }): ModelDef =>
	def(id, id, "video", "sudashui-video", sudashuiParams(opts?.res ?? ["720p"], opts?.hn), opts?.cost ?? 30, {
		channelId: CH_SUDASHUI, upstreamModel: upstream, modeId,
		methods: ["omni", "frames"], costField: "duration", costPerUnit: opts?.perUnit ?? 2,
		...opts?.extra,
	});

// ── 星辰（AIStartLab）xc 系（第132轮）───────────────────────────────────
// 14 个外显模型 = 上游 11 条线路 17 个 (channel,model) 组合全接（用户定「全部接上」）。
// 命名按**素材量**（图/视/音上限）：933=图9视3音3 / 900=图9 / 700=图7 / 100=图1；
// 后缀：-fast=快速版 / -c=特价线（沿用简梦 431/933/900 命名体系）。
// upstreamModel 编码 "channel|model|quality"（同一模型编码横跨多线、每线一个质量档——线路必须钉死，
// 见 translators/aistars.ts）；xc933 双雄分辨率档经 routes 换质量档（同 48 线，仅价随档变）。
// 首尾帧=48 线 fast（frames2video）；必须带图的线（51 grok 系）翻译器前置报错。
// 价=占位（按秒线按秒、按条线按次），上线前管理端定真价；matLimits 按 2026-07-22 config 实测下种（管理端可再收紧）。
const aisParams = (o?: { res?: string[]; aspects?: string[]; durOpts?: number[]; durMin?: number; durMax?: number }): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: o?.res ?? ["720p"], default: (o?.res ?? ["720p"])[0] },
	o?.durOpts
		? { key: "duration", label: "时长", type: "enum", options: o.durOpts.map(String), default: String(o.durOpts[o.durOpts.length - 1]), unit: "s" }
		: { key: "duration", label: "时长", type: "number", default: Math.min(15, o?.durMax ?? 15), min: o?.durMin ?? 4, max: o?.durMax ?? 15, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: o?.aspects ?? ["16:9", "9:16", "1:1"], default: "16:9" },
];
const AIS_ASPECTS_3 = ["16:9", "9:16", "1:1"];
/** 50/56 线 5 比例（2026-08-09 config） */
const AIS_ASPECTS_5 = ["16:9", "9:16", "1:1", "4:3", "3:4"];
/** 47/48/53/49 线 6 比例（2026-08-09 config，含 21:9） */
const AIS_ASPECTS_6 = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
/** 51 线 grok1.0 7 比例（2026-08-09 config 起，+4:3/3:4） */
const AIS_GROK_ASPECTS = ["16:9", "9:16", "1:1", "2:3", "3:2", "4:3", "3:4"];
/** 59/60/21 线与 grok1.5 双比例 */
const AIS_HV = ["16:9", "9:16"];
/** xc933-sd2.0：480p/720p/1080p/4k 四档经 routes 换质量档（第148轮全在 48 线「专线」，仅价随档变；质量档大小写按上游：4K 大写） */
const XC933_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "48|seedance-2.0|480p", cost: 38, costPerUnit: 2.5 },
	{ when: { resolution: "720p" }, upstreamModel: "48|seedance-2.0|720p", cost: 53, costPerUnit: 3.5 },
	{ when: { resolution: "1080p" }, upstreamModel: "48|seedance-2.0|1080p", cost: 105, costPerUnit: 7 },
	{ when: { resolution: "4k" }, upstreamModel: "48|seedance-2.0|4K", cost: 285, costPerUnit: 19 },
];
/** xc933-sd2.0-fast（48 线 fast，支持首尾帧）：480p/720p 两档 */
const XC933_FAST_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "48|seedance-2.0-fast|480p", cost: 30, costPerUnit: 2 },
	{ when: { resolution: "720p" }, upstreamModel: "48|seedance-2.0-fast|720p", cost: 45, costPerUnit: 3 },
];
/** xc933-sd2.0-mj（53 线「限时特惠·漫剧优选」，第162轮；上游 32/46/72 积分/秒）：三档质量 */
const XC933_MJ_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "53|seedance-2.0|480p", cost: 30, costPerUnit: 2 },
	{ when: { resolution: "720p" }, upstreamModel: "53|seedance-2.0|720p", cost: 45, costPerUnit: 3 },
	{ when: { resolution: "1080p" }, upstreamModel: "53|seedance-2.0|1080p", cost: 68, costPerUnit: 4.5 },
];
/** xc933-sd2.0-fast-mj（53 线 fast，支持首尾帧；上游 26/38 积分/秒）：两档质量 */
const XC933_FAST_MJ_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "53|seedance-2.0-fast|480p", cost: 23, costPerUnit: 1.5 },
	{ when: { resolution: "720p" }, upstreamModel: "53|seedance-2.0-fast|720p", cost: 38, costPerUnit: 2.5 },
];
// ── 2026-08-09 config 新接线路的质量档 routes（第216轮「全部接上」；全部按秒/按条**占位价**，上线前管理端定真价）──
/** xc933-sd2.0-p（47 线「普通线路」，上游默认线；上游 36/52/80/260 积分/秒——比 48 专线便宜一档） */
const XC933_P_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "47|seedance-2.0|480p", cost: 30, costPerUnit: 2 },
	{ when: { resolution: "720p" }, upstreamModel: "47|seedance-2.0|720p", cost: 45, costPerUnit: 3 },
	{ when: { resolution: "1080p" }, upstreamModel: "47|seedance-2.0|1080p", cost: 75, costPerUnit: 5 },
	{ when: { resolution: "4k" }, upstreamModel: "47|seedance-2.0|4K", cost: 240, costPerUnit: 16 },
];
/** xc933-sd2.0-fast-p（47 线 fast；上游 28/42 积分/秒） */
const XC933_FAST_P_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "47|seedance-2.0-fast|480p", cost: 23, costPerUnit: 1.5 },
	{ when: { resolution: "720p" }, upstreamModel: "47|seedance-2.0-fast|720p", cost: 38, costPerUnit: 2.5 },
];
/** xc-sd2.5（54 线 Seedance 2.5；上游 45/68 积分/秒、4-30s——兜底价按最高 30s） */
const XC_SD25_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "54|seedance-2.5|480p", cost: 90, costPerUnit: 3 },
	{ when: { resolution: "720p" }, upstreamModel: "54|seedance-2.5|720p", cost: 135, costPerUnit: 4.5 },
];
/** xc903-minimax-h3（59 线；上游 12/16 积分/秒） */
const XC_H3_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "59|minimax-h3|480p", cost: 15, costPerUnit: 1 },
	{ when: { resolution: "720p" }, upstreamModel: "59|minimax-h3|720p", cost: 23, costPerUnit: 1.5 },
];
/** xc300-kling3（60 线；上游 16/20 积分/秒） */
const XC_KLING_ROUTES: ModelRoute[] = [
	{ when: { resolution: "720p" }, upstreamModel: "60|kling-v3|720p", cost: 23, costPerUnit: 1.5 },
	{ when: { resolution: "1080p" }, upstreamModel: "60|kling-v3|1080p", cost: 30, costPerUnit: 2 },
];
/** xc900-hh1.0 / hh1.1（56 线快乐马；上游 28/46 与 34/52 积分/秒） */
const XC_HH10_ROUTES: ModelRoute[] = [
	{ when: { resolution: "720p" }, upstreamModel: "56|happyhorse-1.0|720p", cost: 30, costPerUnit: 2 },
	{ when: { resolution: "1080p" }, upstreamModel: "56|happyhorse-1.0|1080p", cost: 45, costPerUnit: 3 },
];
const XC_HH11_ROUTES: ModelRoute[] = [
	{ when: { resolution: "720p" }, upstreamModel: "56|happyhorse-1.1|720p", cost: 38, costPerUnit: 2.5 },
	{ when: { resolution: "1080p" }, upstreamModel: "56|happyhorse-1.1|1080p", cost: 53, costPerUnit: 3.5 },
];
/** 星辰模型简写工厂：外显 id=label、模式 xingchen；perUnit 填了=按秒计费占位价，不填=按次固定价（跟随上游按条线形状） */
const ais = (id: string, upstream: string, perUnit: number | null, cost: number, params: ParamField[], extra?: Partial<ModelDef>): ModelDef =>
	def(id, id, "video", "aistars-video", params, cost, {
		channelId: CH_AISTARS, upstreamModel: upstream, modeId: "xingchen",
		...(perUnit != null ? { costField: "duration", costPerUnit: perUnit } : {}),
		...extra,
	});
// 星辰图片（第162轮，协议 aistars-image）：2026-07-26 config imageConfig 三线（52 GPT 推荐 / 46 GPT 特价 Low /
// 23 Nano Banana 双 Gemini 款）。质量档（1K/2K/4K）钉在编码/routes（价随档变，与视频质量档同款）；
// 比例=客户端 size 参数（比例串下拉）经翻译器就近映射线路 aspects。按次**占位价**=上游积分数值
//（上游 100 积分≈1 元 → 5-20 积分/张量级；上线前管理端定真价）。守卫见 translators/aistars.ts 图片段。
const AIS_IMG_RES: ParamField = { key: "resolution", label: "分辨率档", type: "enum", options: ["1k", "2k", "4k"], default: "2k" };
const aisImgSize = (aspects: string[]): ParamField => ({ key: "size", label: "画幅比例", type: "enum", options: aspects, default: aspects.includes("1:1") ? "1:1" : aspects[0] });
const AIS_IMG_ASPECTS_5 = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const AIS_IMG_ASPECTS_8 = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
/** 星辰图片模型简写工厂：base="线路|模型"，编码默认 2K 档、1k/4k 经 routes 换档换价；归星辰模式 */
const aisImg = (id: string, base: string, costs: { oneK: number; twoK: number; fourK: number }, imgMax: number, aspects: string[]): ModelDef =>
	def(id, id, "image", "aistars-image", [AIS_IMG_RES, aisImgSize(aspects)], costs.twoK, {
		channelId: CH_AISTARS, upstreamModel: `${base}|2K`, modeId: "xingchen",
		routes: [
			{ when: { resolution: "1k" }, upstreamModel: `${base}|1K`, cost: costs.oneK },
			{ when: { resolution: "4k" }, upstreamModel: `${base}|4K`, cost: costs.fourK },
		],
		matLimits: { img: imgMax, vid: 0, aud: 0 },
	});

// ── 画影（AI-Studio aixyzz）hy 系（第133轮）──────────────────────────────
// 6 个外显模型 = 上游 GET /v1/models 全量（2026-07-18 真机实测；owned_by=agent 的代理线，清单随上游账号调整）。
// 命名按**素材量**（图/视/音上限，沿用简梦/星辰体系）：933=9/3/3、903=9/0/3、900=9/0/0、431=4/3/1；-fast=快速线。
// 上游同一模型不分分辨率线路（resolution 是普通请求参数、上游价与档位无关）——无需 routes 重定向。
// ⚠ 首尾帧（firstFrame/lastFrame）文档有但 6 条线真机全拒（invalid_input，2026-07-18 实测）→ 不声明
//    methods（客户端不出「方法」下拉，全能参考即缺省）；上游放开后在模型补 methods 并恢复 huaying.ts 的 frames 分支。
// 计费占位价（上线前管理端定真价）：上游按秒线 0.61-0.72 POINT/秒、按条线 5/5.4 POINT/条；
// 我们侧 按秒线→按秒占位（2-3/秒），按条线→按次占位（上游平价计费，跟随其形状）。
const HY_ASPECTS_6 = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
const HY_ASPECTS_3 = ["16:9", "1:1", "9:16"];
const hyParams = (res: string[], aspects: string[]): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: res, default: res[0] },
	{ key: "duration", label: "时长", type: "number", default: 15, min: 4, max: 15, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: aspects, default: "16:9" },
];
/** 画影模型简写工厂：外显 id=label、模式 huaying；perUnit 填了=按秒计费，不填=按次固定价 */
const hy = (id: string, upstream: string, params: ParamField[], cost: number, perUnit?: number, extra?: Partial<ModelDef>): ModelDef =>
	def(id, id, "video", "huaying-video", params, cost, {
		channelId: CH_HUAYING, upstreamModel: upstream, modeId: "huaying",
		...(perUnit != null ? { costField: "duration", costPerUnit: perUnit } : {}),
		...extra,
	});

// ── Dimensio（jimeng.dimensio.cn）dm 系（第134轮）──────────────────────────
// 3 个外显模型 = 上游「当前开放模型」全量（Seedance 2.0 系列）。命名按素材量（全线 图9视3音3 → 933）。
// 全线支持 全能参考(omni_reference) + 首尾帧(first_last_frames) → methods:["omni","frames"]；守卫见 translators/dimensio.ts。
// 上游按秒计价（积分/秒）：fast-vip 44 / mini 36 / vip 56（720p）·140（1080p）→ 我们侧按秒**占位价**
// （上线前管理端定真价）；vip 的 1080p 档经 routes 覆盖每秒价（同一上游模型名，仅价随档变——与 gf903 半同款，无线路重定向）。
const DM_ASPECTS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
const dmParams = (res: string[]): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: res, default: res[0] },
	{ key: "duration", label: "时长", type: "number", default: 15, min: 4, max: 15, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: DM_ASPECTS, default: "16:9" },
];
/** Dimensio 模型简写工厂：外显 id=label、模式 dimensio、按秒计费占位价；
 *  refVideoSecondsWeight=1（第140轮用户定：参考视频秒与出片每秒价同价折算，不足1秒算1秒） */
const dm = (id: string, upstream: string, res: string[], perUnit: number, cost: number, extra?: Partial<ModelDef>): ModelDef =>
	def(id, id, "video", "dimensio-video", dmParams(res), cost, {
		channelId: CH_DIMENSIO, upstreamModel: upstream, modeId: "dimensio",
		methods: ["omni", "frames"], costField: "duration", costPerUnit: perUnit,
		refVideoSecondsWeight: 1, ...extra,
	});

// ── Aivide 2.0（aivideo.beauty）av 系（第139轮）──────────────────────────────
// 1 个外显模型 = 上游固定 model "aivide-2.0"（官方文档 v2.0，2026-07-17）。命名按素材量：图9视3音3 → 933
// （⚠ 上游约束：参考视频+参考音频**合计 ≤3**，守卫见 translators/aivide.ts）。文档无首尾帧字段 →
// 不声明 methods（客户端不出「方法」下拉，全能参考即缺省——与画影同款）；「带故事板」并入 image_urls 末尾。
// 上游未公布单价 → 按秒**占位价** 3/秒（上线前管理端定真价）；兜底价=3×15=45（「默认按最高」规则，第134轮补充2）。
const AV_PARAMS: ParamField[] = [
	{ key: "resolution", label: "分辨率", type: "enum", options: ["480p", "720p"], default: "720p" },
	{ key: "duration", label: "时长", type: "number", default: 15, min: 4, max: 15, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16"], default: "16:9" },
];

// ── 简梦P 3 模型（第147轮接入；第159轮 +gemini-omni-flash −veo31/-ref；第242轮按 2026-08 新版文档收敛 +H3、
//    删 Sora 系；同轮补充：用户令**恢复 gemini-omni-flash / veo31-fast**——新文档虽言「当前仅支持 H3video-2k」，
//    这两款按旧形态保留接入，上游若真不再支持=明确报错+失败自动退款，无静默风险）──
// 外显模型名=上游公开模型名（用户定「模型为 api 文档所示」，文档即对外名、无内部编码可泄）。
// 2026-08 新版文档（Base https://api.pixellelabs.com，本轮起文档明给——渠道 Base URL 按它配）：
//   H3video-2k（MiniMax Hailuo H3）：分辨率仅 2K · 时长仅 15s（字符串下发，翻译器换算）· 六比例 ·
//   图≤9/视≤3/音≤3（合计≤12）· 不支持尾帧图；参考视频/音频时长约束上游自校验。
//   classifyFamily 认不出 h3video 字样 → familyId 显式钉 fam-minimax（与 sl933/adl/xc903 的 H3 同族）。
// 恢复两款（能力按第159轮 2026-07 文档矩阵原样；翻译器走旧字段形态 legacy，见 translators/jianmengp.ts）：
//   gemini-omni-flash 720p/1080p（默认 720p）· 16:9/9:16 · 时长 4/6/8/10 · 图≤5（风格参考）/视≤1、无音频
//   veo31-fast        720p/1080p（默认 1080p）· 16:9/9:16 · 时长 4/6/8 · 图≤2、无视频/音频（图片即帧参考）
// matLimits 按文档下种（管理端可再收紧；不入 MODEL_REFRESH_FIELDS，seed 刷新不冲）。
// 上游未公布单价 → 按秒**占位价**（上线前管理端定真价）；H3 5/秒（2K 档参照算力 H3 1080p 占位尺）
// 兜底=5×15=75（「默认按最高」规则，第134轮补充2）；恢复两款沿用第159轮占位价（生产存量的管理端真价不受
// 迁移影响——⑤k v1 不再删它们）。
const jmpH3Params = (): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: ["2K"], default: "2K" },
	{ key: "duration", label: "时长", type: "enum", options: ["15"], default: "15", unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"], default: "16:9" },
];
const jmpGeminiParams = (): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: ["720p", "1080p"], default: "720p" },
	{ key: "duration", label: "时长", type: "enum", options: ["4", "6", "8", "10"], default: "10", unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16"], default: "16:9" },
];
const jmpVeoParams = (): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: ["1080p", "720p"], default: "1080p" },
	{ key: "duration", label: "时长", type: "enum", options: ["4", "6", "8"], default: "8", unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16"], default: "16:9" },
];
/** 简梦P 模型简写工厂：外显 id=label=上游模型名、模式 jmp、按秒计费占位价 + 文档素材上限；
 *  familyId 缺省交 classifyFamily（gemini/veo 名字认得出），仅 H3 需显式钉 fam-minimax */
const jmp = (id: string, params: ParamField[], perUnit: number, cost: number, matLimits: MatLimits, familyId?: string): ModelDef =>
	def(id, id, "video", "jianmengp-video", params, cost, {
		channelId: CH_JIANMENGP, modeId: "jmp", familyId,
		costField: "duration", costPerUnit: perUnit, matLimits,
	});

// ── 简梦M（MuseAI museai.vip）4 模型（第151轮）──────────────────────────────
// 文档「可用模型列表以此处为准」只接 4 款「可用」（500/501 火山渠道按秒线标注维护中不接；
// 请求 enum 里的 _H/_ART/_XH 等不在权威表也不接）。命名按素材量（图/视/音）：K 线=403、HU 线=933。
// 上游**按次计费**（K 4800/4000、HU 5999/4500 上游积分/次）→ 我们侧按次**占位价**（上线前管理端定真价）。
// 全线 720p（参数单档展示）；无首尾帧字段 → 不声明 methods（全能参考单方法）；守卫见 translators/musem.ts。
const JMM_ASPECTS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const jmmParams = (): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: ["720p"], default: "720p" },
	{ key: "duration", label: "时长", type: "number", default: 15, min: 4, max: 15, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: JMM_ASPECTS, default: "16:9" },
];
/** 简梦M 模型简写工厂：外显 id=label、模式 jmm、按次占位价 + 文档表素材上限 */
const jmm = (id: string, upstream: string, cost: number, matLimits: MatLimits): ModelDef =>
	def(id, id, "video", "musem-video", jmmParams(), cost, {
		channelId: CH_MUSEM, upstreamModel: upstream, modeId: "jmm", matLimits,
	});

// ── 简梦Z（zexitongxue.com）14 模型（第152轮）────────────────────────────
// 外显名=上游公开模型名加 jmz- 前缀（该站「客户只使用本站公开模型名」——与简梦P 同理无内部编码可泄；
// 加前缀防与 Qiji 模式 seedance-2.0 家族及未来渠道撞名）。只接实时目录 /ai-api/models can_use=true 的 14 款
//（doubao-seedance-2-0-4k 维护中不接）。能力按 2026-07-23 实时目录（note/duration_profile/max_reference_images）：
//   豆包三线 图9视3音5 + 首尾帧（目录 note 明示「支持首尾帧+真人参考图已真实出片」→ methods omni+frames）；
//   480p-pro/grok 目录明示不支持视频/音频参考 → vid0 aud0；431 线图4；其余线只注明图9、视/音未注明 →
//   matLimits 只设 img（不臆造 0——键缺省=不限，翻译器同样不拦、上游兜底，与苏打水 gf2 同规则）。
// 计费：按次线（dolo/dolo-2/grok/480p-pro/两条 431）=上游按次 → 我方按次占位价（上游元价×10）；
//   按秒线（pro2/720p-pro/enhance/fast 双线）=上游按秒 → 我方按秒占位价，兜底=每秒价×最长时长（第134轮补充2）；
//   豆包三线上游按 Token（39.1-43.35 元/百万 Token，完成按 usage 多退少补——上游侧机制）→ 我方按秒占位价，
//   ⚠ 与 Token 实耗非线性对应，上线前务必用真单对账定真价。守卫/状态机见 translators/jmz.ts。
const JMZ_ASPECTS = ["16:9", "9:16"]; // ⚠ 文档未给比例枚举表、示例仅两档——先按实证下种；管理端加档即放行（翻译器不收敛原样透传）
const jmzParams = (res: string, dur: ParamField): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: [res], default: res },
	dur,
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: JMZ_ASPECTS, default: "16:9" },
];
const jmzDurRange = (min: number, max: number, dflt: number): ParamField =>
	({ key: "duration", label: "时长", type: "number", default: dflt, min, max, step: 1, unit: "s" });
const jmzDurOpts = (opts: number[], dflt: number): ParamField =>
	({ key: "duration", label: "时长", type: "enum", options: opts.map(String), default: String(dflt), unit: "s" });
/** 简梦Z 模型简写工厂：外显 id=label、模式 jmz；perUnit 填了=按秒计费，不填=按次固定价 */
const jmz = (id: string, upstream: string, params: ParamField[], cost: number, matLimits: MatLimits, o?: { perUnit?: number; extra?: Partial<ModelDef> }): ModelDef =>
	def(id, id, "video", "jmz-video", params, cost, {
		channelId: CH_JMZ, upstreamModel: upstream, modeId: "jmz", matLimits,
		...(o?.perUnit != null ? { costField: "duration", costPerUnit: o.perUnit } : {}),
		...o?.extra,
	});
// 简梦Z 图片（第153轮）：同站 /v1/images 异步接口 7 款（协议 jmz-image，翻译器/能力表见 translators/jmz.ts 图片段）。
// 分辨率档=我方 resolution（1k/2k/4k）：gemini 双子映射 quality 1K/2K/4K；gpt 走像素尺寸+quality；grok 仅比例无质量档。
// ⚠ gpt-image-2 的 1K/2K/4K 实际能力由 API Key 所在分组决定（default/image2/image2 4k，站方控制台配置）——要 4K
//   让运营把 Key 分到「image2 4k」分组，我方不传任何上游线路信息。占位价≈上游元价×100（0.07/0.09/0.022 元/次；
//   grok pro/lite/edit 不在实时目录、价格未知按邻档插值），上线前管理端定真价。
const jmzImgRes = (): ParamField => ({ key: "resolution", label: "分辨率档", type: "enum", options: ["1k", "2k", "4k"], default: "2k" });
const JMZ_GPT_IMG_SIZE: ParamField = {
	key: "size", label: "尺寸", type: "enum",
	options: ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x1152", "3840x2160", "2160x3840"],
	default: "auto",
};
/** 简梦Z 图片模型简写工厂：外显 id=label、模式 jmz、按次占位价 + 参考图上限（纯文生款=0） */
const jmzImg = (id: string, upstream: string, params: ParamField[], cost: number, imgMax: number): ModelDef =>
	def(id, id, "image", "jmz-image", params, cost, {
		channelId: CH_JMZ, upstreamModel: upstream, modeId: "jmz",
		matLimits: { img: imgMax, vid: 0, aud: 0 },
	});

// ── 简梦T（llm.chre3.com）1 模型（第160轮）──────────────────────────────
// 单模型渠道：上游固定 model "sd2-c8"（Seedance 2.0 满血版，OpenAI 兼容形态）。命名按素材量：
// 图9视3音3 → jmt933-sd2.0。720p 固定（参数单档展示、翻译器不发 size）；时长 5-15 整数秒；
// 六比例（16:9 默认）；真人参考支持、生成音频默认开启（无开关字段）。无首尾帧字段 →
// 不声明 methods（全能参考单方法）；音频参考须搭配图/视频（守卫见 translators/jmt.ts）。
// compliance_mode=合规素材（本文档新增「人脸参数」：off=不开启；彩铅/水彩/渔网/眼部遮罩四风格，
// 翻译器命中白名单才发 compliance_enabled+compliance_mode）。
// 上游未公布单价 → 按秒**占位价** 3/秒（上线前管理端定真价）；兜底价=3×15=45（「默认按最高」规则，第134轮补充2）。
const JMT_PARAMS: ParamField[] = [
	{ key: "resolution", label: "分辨率", type: "enum", options: ["720p"], default: "720p" },
	{ key: "duration", label: "时长", type: "number", default: 15, min: 5, max: 15, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1", "21:9", "3:4", "4:3"], default: "16:9" },
	{ key: "compliance_mode", label: "合规素材", type: "enum", options: ["off", "colored-pencil", "watercolor", "fishnet", "grid"], default: "off" },
];

// ── 简梦F（new.vosle.xyz）1 模型（第161轮）──────────────────────────────
// 单模型渠道：上游模型 ID 动态拼接 `seedance-2.0+{16:9|9:16}+{720}+{5|10|15}`——种子 upstreamModel 只存
// 基名，翻译器按请求参数现拼（见 translators/jmf.ts；管理端自建含 "+" 的完整 ID 原样直发）。
// 命名按素材量：图9视3音3 → jmf933-sd2.0。720p 固定（管理端给 resolution 加档即放行现拼段）；
// 时长离散档 5/10/15；两比例；**首尾帧文档明确支持（start_frame/end_frame）→ methods omni+frames**；
// 提示词≤8000 字符前置拦截；音频参考须搭配图/视频；生成音频默认开启（generate_audio 参数可关）。
// 上游未公布单价 → 按秒**占位价** 3/秒（上线前管理端定真价）；兜底价=3×15=45（「默认按最高」规则，第134轮补充2）。
const JMF_PARAMS: ParamField[] = [
	{ key: "resolution", label: "分辨率", type: "enum", options: ["720p"], default: "720p" },
	{ key: "duration", label: "时长", type: "enum", options: ["5", "10", "15"], default: "15", unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16"], default: "16:9" },
	{ key: "generate_audio", label: "生成音频", type: "enum", options: ["true", "false"], default: "true" },
];

// ── 出海营（overseas · api.aiid.edu.kg）5 模型（第186轮）──────────────────
// Seedance 任务格式（POST /api/v3/contents/generations/tasks）：素材经 content 数组混排（name=@ImageN 图例
// 编号）、生成配置顶层 duration/ratio/resolution；分辨率档经 routes 重定向到上游后缀款（-1080p/-4k/-480p），
// 上游真名对用户隐藏。首尾帧走兼容 mode:"i2v_first_last"（image_url/end_image_url）→ methods omni+frames；
// gemini-omni 同接口（mode t2v/r2v/edit 按素材自动定；4/6/8/10 就档由上游自动完成）。守卫见 translators/overseas.ts。
// ⚠ 时长/比例/分辨率翻译器**原样透传绝不静默改写**（第188轮用户定稿）——档位只在这里的参数定义把关。
// 素材上限文档未给 → 按 Seedance 惯例 933（图9视3音3）；gemini 参照 jmp gemini-omni-flash（图5视1）。
// 上游未公布单价 → 按秒**占位价**（上线前管理端定真价）；兜底价=每秒价×最长时长 15（「默认按最高」规则，第134轮补充2）。
const osParams = (res: string[], maxDur = 15): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: res, default: res[0] },
	{ key: "duration", label: "时长", type: "number", default: 15, min: 4, max: maxDur, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1", "21:9", "3:4", "4:3"], default: "16:9" },
	{ key: "generate_audio", label: "生成音频", type: "enum", options: ["true", "false"], default: "true" },
];
const OS_GEMINI_PARAMS: ParamField[] = [
	{ key: "resolution", label: "分辨率", type: "enum", options: ["720p"], default: "720p" },
	{ key: "duration", label: "时长", type: "enum", options: ["4", "6", "8", "10"], default: "8", unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1"], default: "16:9" },
];
/** 出海营模型简写工厂：外显 id=label、模式 overseas、按秒占位价 + 933 素材上限 + 首尾帧方法；
 *  maxDur=时长上限（sd-2-5 支持 30s——第187轮用户实锤，其余款按惯例 15） */
const os = (id: string, upstream: string, res: string[], perUnit: number, cost: number, extra?: Partial<ModelDef>, maxDur = 15): ModelDef =>
	def(id, id, "video", "overseas-video", osParams(res, maxDur), cost, {
		channelId: CH_OVERSEAS, upstreamModel: upstream, modeId: "overseas",
		methods: ["omni", "frames"], costField: "duration", costPerUnit: perUnit,
		matLimits: { img: 9, vid: 3, aud: 3 },
		...extra,
	});

// ── 简梦H（ZhengAPI zhengapi.top）图片 6 模型（第154轮）────────────────────
// 同步单请求渠道（协议 jmh-image 复用 createImageTask 图片管线，无轮询）；两形态见 translators/jmh.ts：
//   grok 双款走 /v1/images/generations（参考图=单值纯 base64 字段 → matLimits 图1；-edit 图生图专用无图报错）；
//   firefly 四款走 /v1/chat/completions（stream:false）+ **模型 ID 拼分辨率/比例后缀**（-{1k|2k|4k}-{16x9…}，
//   翻译器按我方 resolution 档+size 就近比例现拼）——参考图张数未文档化不设上限（chat 形态按序多张，待真机实锤）。
// 价格未公布 → 全员按次占位价（上线前管理端定真价）。视频系（grok/sora/veo/kling/runway chat 流式）本轮未接。
const jmhImgRes = (): ParamField => ({ key: "resolution", label: "分辨率档", type: "enum", options: ["1k", "2k", "4k"], default: "2k" });
/** 简梦H 图片模型简写工厂：外显 id=label、模式 jmh、按次占位价；imgMax 填了才设 matLimits（firefly 未文档化不设） */
const jmh = (id: string, upstream: string, params: ParamField[], cost: number, imgMax?: number): ModelDef =>
	def(id, id, "image", "jmh-image", params, cost, {
		channelId: CH_JMH, upstreamModel: upstream, modeId: "jmh",
		...(imgMax != null ? { matLimits: { img: imgMax, vid: 0, aud: 0 } } : { matLimits: { vid: 0, aud: 0 } }),
	});
// 简梦H 视频（第155轮）：同站 chat/completions SSE 流式单请求 9 款（协议 jmh-video，模型 ID 按家族现拼
// 时长/比例/分辨率后缀——翻译器 VID_CAPS 表，见 translators/jmh.ts 视频段）。全渠道仅图片参考（视/音=0）；
// veo31/-fast/kling3 文档有首尾帧示例 → methods omni+frames。价格未公布 → 按秒占位价（兜底=每秒价×最长时长，
// 「默认按最高」规则第134轮补充2）；上线前管理端定真价。
const jmhVidParams = (res: string[] | null, dur: ParamField, aspects: string[]): ParamField[] => [
	...(res ? [{ key: "resolution", label: "分辨率", type: "enum", options: res, default: res[0] } as ParamField] : []),
	dur,
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: aspects, default: "16:9" },
];
/** 简梦H 视频模型简写工厂：外显 id=label、模式 jmh、按秒占位价 + 仅图参考（imgMax 未文档化不设） */
const jmhVid = (id: string, upstream: string, params: ParamField[], perUnit: number, cost: number, imgMax?: number, extra?: Partial<ModelDef>): ModelDef =>
	def(id, id, "video", "jmh-video", params, cost, {
		channelId: CH_JMH, upstreamModel: upstream, modeId: "jmh",
		costField: "duration", costPerUnit: perUnit,
		...(imgMax != null ? { matLimits: { img: imgMax, vid: 0, aud: 0 } } : { matLimits: { vid: 0, aud: 0 } }),
		...extra,
	});

// ── Yali AI Studio（api.yaliai.com）图片 4 模型（第229轮）────────────────────
// 同步单请求渠道（协议 yali-image 复用 createImageTask 图片管线，无轮询）；统一走 OpenAI Images 形态
// （/v1/images/generations 与 /v1/images/edits），见 translators/yali.ts。
// ⚠ **一把 Key 绑定一种接口类型**（文档 §认证）→ 按接口类型分两个渠道：OpenAI Images 类走 CH_YALI_OPENAI、
//   Banana/Gemini 类走 CH_YALI_GEMINI，各填各的 Key（错配上游返 403，翻译器错误文案已明确指路）。
// 规格：`size`（像素或比例写法）+ `resolution`（1k/2k/4k）——⚠ 比例写法**必须配 resolution** 才映射
//   （文档明示 ratio/aspect_ratio 不替代 size）→ 参数表只给这两项、不给 ratio。翻译器原样透传（§9）。
// ⚠ Gemini 3.1 Flash 的最小档 "512"（0.5k）**不是 OpenAI Images 规格**（文档明示仅属其原生 imageSize）
//   → 走本形态时不开该档；要用需另走 /v1beta/...:generateContent 原生路径（后续可选项）。
// quality 仅 OpenAI Images 类有效（Gemini 类由翻译器按上游名跳过，文档明示上游会剥掉）。
// 参考图上限 6 张（文档硬限），优先公网直链、字节兜底走 Data URL 内联（单张 12MiB/合计 30MiB）。
// 上游未公布单价 → 全员按次**占位价**（上线前管理端定真价）。视频（Grok Videos 异步）本轮未接。
const YALI_QUALITY: ParamField = { key: "quality", label: "质量", type: "enum", options: ["auto", "low", "medium", "high"], default: "high" };
/** OpenAI Images 类尺寸：auto + 官方比例档（须配 resolution）+ 常用具体像素 */
const YALI_OPENAI_SIZE: ParamField = {
	key: "size", label: "尺寸", type: "enum",
	options: ["auto", "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9", "2:1", "1:2", "1024x1024", "2048x1152", "1152x2048"],
	default: "auto",
};
/** Gemini 类比例档（文档「模型能力矩阵」aspectRatio 列；3.1 Flash 另有 1:4/1:8/4:1/8:1 极端比例） */
const YALI_GEMINI_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];
const yaliSize = (ratios: string[]): ParamField =>
	({ key: "size", label: "比例", type: "enum", options: ratios, default: "1:1" });
const yaliRes = (opts: string[], dflt: string): ParamField =>
	({ key: "resolution", label: "分辨率档", type: "enum", options: opts, default: dflt });
/** Yali 图片模型简写工厂：外显 id=label、模式 yali、按次占位价 + 参考图上限 6（文档硬限） */
const yali = (id: string, upstream: string, channelId: string, params: ParamField[], cost: number): ModelDef =>
	def(id, id, "image", "yali-image", params, cost, {
		channelId, upstreamModel: upstream, modeId: "yali",
		matLimits: { img: 6, vid: 0, aud: 0 },
	});

// ── Skylee（api.808relay.com）图片 12 模型（第230轮）──────────────────────────
// 异步渠道（协议 skylee-image：POST /v1/images/generations?async=true → GET /v1/images/tasks/{id}，
// 复用视频轮询管线按 image 能力落资产）；翻译器/款式形态见 translators/relay808.ts。
// 外显名=站点公开模型名加 sky- 前缀（防与既有 gpt-image-2 / jmz-*/yali-* 撞名）。
// ⚠ 上游模型名逐字照抄站点清单（`[zz]` 方括号、以及 lite 款名里 `[zz]` 后那个**空格**都不能改）——
//   `[zz]` 系是同款 Gemini 的廉价平行线（便宜 25%~47%），线路差异由站方控制，我方只是换个上游名。
// ⚠ `[zz] gemini-3.1-flash-lite-image` 在站点 /llms.txt 里**只挂 chat/generateContent、未列 images 接口**
//   → 该款走本协议可能被上游拒（明确报错+失败自动退款，无静默风险）；先按图片模型清单接入，
//   运营用小额真单复核，不通就在管理端停用它。
// ⚠ Midjourney 三款「一次任务返回四张图」，本管线一个任务落**一个**资产（取 data[0]），张数记日志 ④ 段。
//   价目分档（Relax 标准 0.40 / Relax HD 1.20 / Fast 标准 0.80 / Fast HD 2.40 元）由**上游账号档位**决定、
//   文档未给请求字段 → 我方按 Relax 标准单档占位价，运营按实际档位在管理端定真价。
// 计费：站点价为元/次 → 占位价 ≈ 元价 × 100（与简梦Z 图片同一折算尺）；`gpt-image-2-token` 上游按 Token
//   计费、与次数非线性对应 → 按最贵档 0.225 保守占位，上线前务必用真单对账。
const skyRes = (): ParamField => ({ key: "resolution", label: "分辨率档", type: "enum", options: ["1k", "2k", "4k"], default: "2k" });
const SKY_GPT_SIZE: ParamField = {
	key: "size", label: "尺寸", type: "enum",
	options: ["auto", "1024x1024", "1536x1024", "1024x1536", "1536x2048", "2048x1536"],
	default: "auto",
};
const SKY_GPT_QUALITY: ParamField = { key: "quality", label: "质量", type: "enum", options: ["auto", "low", "medium", "high"], default: "auto" };
const SKY_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"];
const skySize = (): ParamField => ({ key: "size", label: "比例", type: "enum", options: SKY_RATIOS, default: "1:1" });
/** Skylee 图片模型简写工厂：外显 id=label、模式 skylee、按次占位价 + 参考图上限（文档未公布逐款上限，按同款模型惯例值） */
const sky = (id: string, upstream: string, params: ParamField[], cost: number, imgMax: number): ModelDef =>
	def(id, id, "image", "skylee-image", params, cost, {
		channelId: CH_SKYLEE, upstreamModel: upstream, modeId: "skylee",
		matLimits: { img: imgMax, vid: 0, aud: 0 },
	});

// ── congge（congchen.top·聪宸）图片 3 + 视频 4 模型（第233轮）──────────────────
// 同站同一把 Key，两条协议：congge-image（同步单请求，generations 文生图 / edits 图生图）、
// congge-video（异步 submit+poll，Seedance 2.0/2.5）。翻译器见 translators/congge.ts。
//
// 【图片】外显名加 cg- 前缀（防与既有 gpt-image-2 / sky-*/yali-* 撞名）；上游名照抄站点清单。
//   参数只给 resolution（客户端分辨率档开关）+ quality（仅 gpt-image-2——Gemini 传了上游明确报错）；
//   比例由客户端出图请求的 size 像素串经翻译器换算（文档明令勿传 size）。垫图上限 4 张（文档硬限）。
//   计价：文档为按次 元/次（gpt low/medium 0.03 · high 0.06；Gemini 1K/2K 0.04 · 4K 0.06）——
//   用户定**统一 10 积分/次占位**（已覆盖最贵档 0.06 元，无按档亏本风险），上线前管理端定真价。
//
// 【视频】按秒计费。⚠ 上游把分辨率编进模型名（`seedance2.0 Mini-480p`，**带空格且大小写敏感**）→
//   我方 4 个外显模型经 routes 按 resolution 重定向到 9 个上游真名（真名对用户隐藏，与 overseas/星辰同尺）。
//   命名按素材量：2.0 系 图9视3音3 → cg933-；2.5 系 图30视10音10 超三位数字惯例 → 名不编码（与 xc-sd2.5 同规）。
//   首尾帧：文档无首/尾帧字段 → 不声明 methods（仅全能参考）。
//   占位价（用户定，元/秒 ×≈120 量级、按 720p 档锚定，其余档按上游元/秒比例折算）：
//     Mini 720p 30 · Fast 720p 40 · 2.0 720p 50 · 2.5 720p 60（积分/秒）；
//   兜底价（duration 缺省时）=每秒价 × 该档最长时长（「默认按最高」规则，第134轮补充2）。
const CG_IMG_RES = (opts: string[]): ParamField =>
	({ key: "resolution", label: "分辨率档", type: "enum", options: opts, default: "2k" });
/** 仅 gpt-image-2 支持；"auto"=不发该字段走上游默认 medium（翻译器判定） */
const CG_IMG_QUALITY: ParamField =
	{ key: "quality", label: "质量", type: "enum", options: ["auto", "low", "medium", "high"], default: "medium" };
/** congge 图片模型简写工厂：外显 id=label、模式 congge、按次占位价 + 垫图上限 4（文档硬限） */
const cgImg = (id: string, upstream: string, params: ParamField[], cost: number): ModelDef =>
	def(id, id, "image", "congge-image", params, cost, {
		channelId: CH_CONGGE, upstreamModel: upstream, modeId: "congge",
		matLimits: { img: 4, vid: 0, aud: 0 },
	});
/** congge 视频参数：分辨率档（→ routes 换上游真名与档价）+ 时长 + 比例（文档只给 16:9/9:16/1:1，需要更多档管理端加） */
const cgVidParams = (res: string[], maxDur: number): ParamField[] => [
	{ key: "resolution", label: "分辨率", type: "enum", options: res, default: "720p" },
	{ key: "duration", label: "时长", type: "number", default: 15, min: 4, max: maxDur, step: 1, unit: "s" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1"], default: "16:9" },
];
/** congge 视频模型简写工厂：外显 id=label、模式 congge、按秒计费；routes 承载「分辨率→上游真名+档价」 */
const cgVid = (
	id: string,
	baseUpstream: string,
	res: string[],
	maxDur: number,
	perUnit: number,
	routes: ModelRoute[],
	mat: MatLimits,
): ModelDef =>
	def(id, id, "video", "congge-video", cgVidParams(res, maxDur), perUnit * maxDur, {
		channelId: CH_CONGGE, upstreamModel: baseUpstream, modeId: "congge",
		costField: "duration", costPerUnit: perUnit, routes, matLimits: mat,
	});
const CG_MAT_20 = { img: 9, vid: 3, aud: 3 };
const CG_MAT_25 = { img: 30, vid: 10, aud: 10 };

// ── autodl（autodl.art·ComfyUI 工作流平台）视频 3 模型（第234轮）───────────────────
// 协议 autodl-video（异步 submit+poll，翻译器见 translators/autodl.ts）。
// ⚠ 一个工作流 = 一个模型：多图参考 / 文生视频 / 首尾帧 三条工作流各有自己的 workflow_id
//   （autodl 控制台工作流页可查）——upstreamModel 种子是占位符「请填写workflow_id」，
//   **部署后必须在管理端逐模型把「上游模型名」改成真实 workflow_id**（未填提交前明确报错不扣费）。
// ⚠ 鉴权：Authorization 原样 Token（不带 Bearer），令牌管理创建、分组选 ComfyUI。
// 底层模型按官方示例（"workflow": "H3文生视频"）判定为 MiniMax H3 → id 带 minimax-h3 归 fam-minimax
//   （classifyFamily minimax 规则在 seedance 数字兜底之前，第216轮）；站方换工作流底模时管理端改名即可。
// 参数：duration 1-10 整数秒（上游默认 5）；resolution 为**中文档位串**（"768p竖" 一类，原样发上游）——
//   多图参考多 1080p竖/1080p横 两档（文档差异），文生/首尾帧只有 480p/768p 四档。
// 计价：上游未公布单价 → 按秒**占位价**（多图参考 3/秒、其余 2/秒），兜底价=每秒价×最长 10s
//   （「默认按最高」规则，第134轮补充2）；上线前管理端定真价，建议先小额真单摸底。
const ADL_WF_PLACEHOLDER = "请填写workflow_id";
const ADL_RES_ALL = ["480p竖", "480p横", "768p竖", "768p横", "1080p竖", "1080p横"];
const ADL_RES_BASE = ["480p竖", "480p横", "768p竖", "768p横"];
const adlParams = (res: string[]): ParamField[] => [
	{ key: "duration", label: "时长", type: "number", default: 5, min: 1, max: 10, step: 1, unit: "s" },
	{ key: "resolution", label: "分辨率", type: "enum", options: res, default: "768p竖" },
];
/** autodl 视频模型简写工厂：模式 autodl、按秒占位价、upstreamModel=workflow_id 占位符（管理端必填） */
const adl = (id: string, label: string, res: string[], perUnit: number, mat: MatLimits, extra?: Partial<ModelDef>): ModelDef =>
	def(id, label, "video", "autodl-video", adlParams(res), perUnit * 10, {
		channelId: CH_AUTODL, upstreamModel: ADL_WF_PLACEHOLDER, modeId: "autodl",
		costField: "duration", costPerUnit: perUnit, matLimits: mat, ...extra,
	});

// ── 奇迹云（自建 autodl 实例池 + ComfyUI 直驱）视频 1 模型（第249轮）─────────────────
// 协议 qijicloud-comfy（submit=入本地队列零外发 HTTP、poll=读池零网络；派单/上传素材/建图/看护
// 全在 store/qijicloudPool.ts 调度循环）。⚠ upstreamModel=工作流骨架名（translators/comfyGraph.ts
// 内嵌常量，非任何外部平台的模型名/workflow_id）——管理端勿改，换骨架=改服务端代码。
// 参数：duration 4-15s；resolution 档经骨架 megapixels 换算（480p 0.4 / 640p 0.7 / 768p 1 / 1080p 2）；
//   aspect_ratio 种子只开 16:9/9:16/1:1 三档——其余 5 档（4:3/3:4/2:3/3:2/21:9）构图层全认，
//   管理端给参数加档即放行（翻译器零改动）。
// 计价：⚠ **用户定稿价**非占位价（2026-08-21 用户定：480p 5 / 640p 8 / 768p 10 / 1080p 20 积分每秒）；
//   routes 按 resolution 只换价不换上游名；兜底价=1080p 20/秒×15s=300（「默认按最高」规则，第134轮补充2）。
const qjcParams = (): ParamField[] => [
	{ key: "duration", label: "时长", type: "number", default: 10, min: 4, max: 15, step: 1, unit: "s" },
	{ key: "resolution", label: "分辨率", type: "enum", options: ["480p", "640p", "768p", "1080p"], default: "768p" },
	{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1"], default: "16:9" },
];
const QJC_ROUTES: ModelRoute[] = [
	{ when: { resolution: "480p" }, upstreamModel: "jianyi933", cost: 75, costPerUnit: 5 },
	{ when: { resolution: "640p" }, upstreamModel: "jianyi933", cost: 120, costPerUnit: 8 },
	{ when: { resolution: "768p" }, upstreamModel: "jianyi933", cost: 150, costPerUnit: 10 },
	{ when: { resolution: "1080p" }, upstreamModel: "jianyi933", cost: 300, costPerUnit: 20 },
];
/** 奇迹云视频模型工厂：模式 qijicloud；id 带 minimax → classifyFamily 自动归 fam-minimax（已核对规则次序） */
const qjc = (id: string, label: string): ModelDef =>
	def(id, label, "video", "qijicloud-comfy", qjcParams(), 300, {
		channelId: CH_QIJICLOUD, upstreamModel: "jianyi933", modeId: "qijicloud",
		costField: "duration", costPerUnit: 10, routes: QJC_ROUTES,
		matLimits: { img: 9, vid: 3, aud: 3 },
	});

// ── BYS（www.boyesir.icu·Boyesir AI）视频 15 模型（第252轮）─────────────────────
// 协议 bys-video（异步 submit+poll，翻译器见 translators/bys.ts）。上游是聚合站：同一底模有几十条线路，
// 本轮按用户定「精选 12–15 款」——每个底模 × 每个档位挑**性价比最高**的一条线接入
// （线上共 69 个模型 id，剩余的都是同底模更贵的平行线；要补随时在管理端新建，协议选 bys-video、
//  渠道选 BYS、上游名照抄站点清单即可，零代码）。
//
// ⚠ 该渠道**只有参考图**（无参考视频/音频、无首尾帧字段）→ 全部模型 matLimits 的 vid/aud 恒 0、
//   一律不声明 methods（无 frames 方法）；参考图上限文档未给，按底模惯例设（翻译器 CAPS 表同值）。
// ⚠ 上游模型名逐字照抄（`seedance2.5-10图` 带中文、`minimax-h3 768p` 带空格）——勿"顺手规范化"。
//
// 计价：**占位价 = 上游元价 × 100**（用户定，2026-08-21）——按秒款 costPerUnit=积分/秒 且
//   routes 按 resolution 换价（多数不换上游名，仅 gf 高清系换名）、兜底价 = 每秒价 × 最长时长
//   （「默认按最高」第134轮补充2）；按次款 cost 固定、不设 costField。**上线前管理端定真价**。
// ⚠ 单价一律以**上游 402 报价实测**为准，勿只照文档页价目表——第252轮实测抓到两处文档过时：
//   `lec-ac-seedance-2-5`（文档 0.47/0.58 → 实际 0.65/1.02 元每秒）、
//   `lec-seedance-2-0-933-stable`（文档 4.2 → 实际 5.5 元/次）。
//   对账法（零成本，402 不扣费）：余额不足的 Key 提交任务，上游回执 `{"detail":"Insufficient balance:
//   this generation costs CNY X"}` 直接给出本次报价；按次款用两个不同 duration 各报一次，同价即确认按次。
const BYS_RATIO: ParamField = { key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1"], default: "16:9" };
const bysRes = (opts: string[], dflt: string): ParamField =>
	({ key: "resolution", label: "分辨率", type: "enum", options: opts, default: dflt });
const bysDur = (min: number, max: number, dflt?: number): ParamField =>
	({ key: "duration", label: "时长", type: "number", default: dflt ?? max, min, max, step: 1, unit: "s" });
const BYS_MAT = (img: number): MatLimits => ({ img, vid: 0, aud: 0 });
/** BYS 按秒计费模型工厂：cost 兜底=每秒价×最长时长；routes 承载「分辨率→档价（+必要时换上游名）」 */
const bysSec = (
	id: string,
	label: string,
	upstream: string,
	params: ParamField[],
	perUnit: number,
	maxDur: number,
	routes: ModelRoute[],
	img: number,
): ModelDef =>
	def(id, label, "video", "bys-video", params, perUnit * maxDur, {
		channelId: CH_BYS, upstreamModel: upstream, modeId: "bys",
		costField: "duration", costPerUnit: perUnit, routes, matLimits: BYS_MAT(img),
	});
/** BYS 按次计费模型工厂：固定 cost、不设 costField（时长可选也不影响价格） */
const bysOnce = (id: string, label: string, upstream: string, params: ParamField[], cost: number, img: number): ModelDef =>
	def(id, label, "video", "bys-video", params, cost, {
		channelId: CH_BYS, upstreamModel: upstream, modeId: "bys", matLimits: BYS_MAT(img),
	});

// ── QiQi（pidoi.com）视频 2 款（第255轮）──────────────────────────────────
// 同站同端点同鉴权，但**两套请求形态并存**（翻译器按上游模型名分派，见 translators/qiqi.ts shapeOf）：
//   content 形态 `seedace-2.0-720p`（《Seedance 视频生成 API 调用文档》）：content[] 多模态数组、
//     支持首尾帧（role first_frame/last_frame）、**不传 resolution**（编在模型名后缀里）、seconds 4–15；
//     ⚠ 用音频/视频参考时必须至少 1 张图（上游硬约束）。
//   flat 形态 `sora-v3-933-pro`（《视频生成接口说明·933真人视频》2026-07-26）：扁平字段
//     image_url + reference_image_urls/reference_videos/audio_urls、**resolution 必填 720p**、
//     seconds 仅 15、**不支持尾帧图**、单次素材总数 ≤12（跨类闸在翻译器）。
// 两形态的**素材引用语法相同**（小写 @image1/@audio1/@video1，用户 2026-08-22 实锤）——都注入图例。
// ⚠ 上游模型名逐字照抄：`seedace-2.0-720p` 文档全篇少一个 n（**不是** seedance，勿"顺手纠正"）。
// ⚠ 两款都**不设 resolution 参数**（各自只有 720p 一档；flat 形态由翻译器恒发 720p）。
// 上游未公布单价（文档：「具体价格以模型广场实时展示为准」，/api/pricing 需登录态）→ 按秒**占位价**
//   （按同类 720p Seedance 2.0 官转线的 元价×100 折算尺估）；兜底价=每秒价×最长时长 15（「默认按最高」
//   第134轮补充2）。**上线前管理端定真价**（建议先小额真单对账）。
const QIQI_RATIO: ParamField = { key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], default: "16:9" };
const QIQI_PARAMS: ParamField[] = [
	{ key: "duration", label: "时长", type: "number", default: 5, min: 4, max: 15, step: 1, unit: "s" },
	QIQI_RATIO,
	{ key: "generate_audio", label: "生成音频", type: "enum", options: ["true", "false"], default: "true" },
];
/** flat 形态（933 真人）：时长仅 15 一档（文档明示），无 generate_audio 字段 */
const QIQI_933_PARAMS: ParamField[] = [
	{ key: "duration", label: "时长", type: "enum", options: ["15"], default: "15", unit: "s" },
	QIQI_RATIO,
];
/** QiQi 模型工厂：按秒占位价 + 933 素材上限；methods 仅 content 形态支持首尾帧 */
const qiqi = (id: string, label: string, upstream: string, perUnit: number, params: ParamField[], methods?: ("omni" | "frames")[]): ModelDef =>
	def(id, label, "video", "qiqi-video", params, perUnit * 15, {
		channelId: CH_QIQI, upstreamModel: upstream, modeId: "qiqi",
		costField: "duration", costPerUnit: perUnit,
		matLimits: { img: 9, vid: 3, aud: 3 },
		...(methods ? { methods } : {}),
	});

const DEFAULT_MODELS: ModelDef[] = [
	// ── G-AISC 聚合网关 ──
	def("gpt-5.5", "GPT-5.5", "text", "openai-chat", TEXT_PARAMS, 10, { channelId: CH_GAISC }),
	def("gpt-image-2", "GPT Image 2", "image", "openai-image", [IMG_RESOLUTION, IMG_SIZE], 20, { channelId: CH_GAISC, modeId: "qiji-img" }),
	// ── 云雾（yunwu.ai）文本渠道（第157轮）：标准 OpenAI chat 协议 → 复用 openai-chat 翻译器零新代码；
	//    聚合站模型众多、文档只给了一个实名 → 先种 1 款打样，其余管理端新建（协议 openai-chat、渠道 云雾、
	//    上游名照抄站内模型名）。⚠ 渠道密钥必须在管理端「云雾」渠道填（openai-chat 的环境兜底是网关密钥）。
	//    -thinking 系响应带 reasoning_content（思考过程）——openai-chat 翻译器只取 content，天然兼容。
	def("yw-doubao-seed-1.8-thinking", "云雾·豆包 Seed 1.8 思考", "text", "openai-chat", TEXT_PARAMS, 10, {
		channelId: CH_YUNWU, upstreamModel: "doubao-seed-1-8-251228-thinking", modeId: "yunwu",
	}),
	// ── 简梦 Seedance（按分辨率重定向；上游真名对用户隐藏；按 duration 秒数计费）──
	def("seedance-2.0", "Seedance 2.0", "video", "jianmeng-video", seedanceParams(["480p", "720p", "1080p"]), 45, {
		channelId: CH_JIANMENG, upstreamModel: "JA-sd2-pro-720", routes: SEEDANCE_PRO_ROUTES,
		costField: "duration", costPerUnit: 3, modeId: "qiji",
	}),
	def("seedance-2.0-fast", "Seedance 2.0 Fast", "video", "jianmeng-video", seedanceParams(["480p", "720p"]), 30, {
		channelId: CH_JIANMENG, upstreamModel: "JA-sd2-fast-720", routes: SEEDANCE_FAST_ROUTES,
		costField: "duration", costPerUnit: 2, modeId: "qiji",
	}),
	// ── 苏打水（简梦S）7 模型（第156轮收编 26→7，用户定「删除舍弃的19款、集合成简梦S」；三模式合一为 jms）──
	//    保留逻辑：gf=官方真人库独家+四档分辨率；hn=老线（第131轮起）；wf=933 唯一带 1080p 的 pro 线；xh=备线。
	//    删除的 19 款（gf2×3/431-pd×2/bf×4（第131轮素材 invalid_asset 前科）/mo×2/ld×2/xh-fast/933-pd×2/xinghe×3）
	//    进墓碑不复活——需要时管理端重建同 id（改 upstreamModel 即换线，请求体全渠道同构）或按 git 历史恢复种子。
	// gf=官方真人库：officialAssets=真人图多选；上游不支持参考视频，翻译器 /^sdas-gf-/ 拦
	def("gf903-sd2.0", "gf903-sd2.0", "video", "sudashui-video", sudashuiParams(["720p", "1080p", "2k", "4k"]), 45, {
		channelId: CH_SUDASHUI, upstreamModel: "sdas-gf-seedance-2.0-720p", routes: GF903_ROUTES,
		modeId: "jms", methods: ["omni", "frames"], officialAssets: true, costField: "duration", costPerUnit: 3, matLimits: SDS_GF,
	}),
	sds("gf903-sd2.0-fast", "sdas-gf-seedance-2.0-fast-720p", "jms", { perUnit: 2, extra: { officialAssets: true, matLimits: SDS_GF } }),
	// hn 老线（时长 5/10/15 三档，翻译器 /^sdas-hn-/ 取档）
	sds("jm431-sd2.0", "sdas-hn-sd2.0-720p", "jms", { hn: true, extra: { matLimits: SDS_431 } }),
	sds("jm431-sd2.0-fast", "sdas-hn-sd2.0-fast-720p", "jms", { hn: true, perUnit: 1.5, cost: 23, extra: { matLimits: SDS_431 } }),
	// wf 线（933 唯一含 1080p 档的 pro 线）+ xh 备线
	sds("jm933-sd2.0-wf", "sdas-wf-sd2.0-pro-933-480p", "jms", { res: ["480p", "720p", "1080p"], perUnit: 1.5, cost: 23, extra: { routes: WF933_ROUTES, matLimits: SDS_933 } }),
	sds("jm933-sd2.0-wf-fast", "sdas-wf-sd2.0-fast-933-480p", "jms", { res: ["480p", "720p"], perUnit: 1, cost: 15, extra: { routes: WF933_FAST_ROUTES, matLimits: SDS_933 } }),
	sds("jm933-sd2.0-xh", "sdas-xh-sd2.0-pro-933-720p", "jms", { extra: { matLimits: SDS_933 } }),
	// ── 星辰（AIStartLab）视频 19 + 图片 5 模型（第148轮换线；第162轮 +53/图片线；**第216轮按 2026-08-09
	//    config「全部接上」**：+47/49/54/56/58/59/60/21 八线 11 视频模型 + 55 图片 High 线；存量能力对齐——
	//    48/47 线 frames 已从 config 消失、51 grok 能力大改）；线路能力/守卫见 translators/aistars.ts ──
	// 48 线「专线」（图9视3音3，按秒）：sd2.0 四档含 1080p/4K；⚠ 2026-08-09 config 起 48 线无 frames（首尾帧改走 53/49 线）
	ais("xc933-sd2.0", "48|seedance-2.0|480p", 2.5, 38, aisParams({ res: ["480p", "720p", "1080p", "4k"], aspects: AIS_ASPECTS_6 }), { routes: XC933_ROUTES, matLimits: { img: 9, vid: 3, aud: 3 } }),
	ais("xc933-sd2.0-fast", "48|seedance-2.0-fast|480p", 2, 30, aisParams({ res: ["480p", "720p"], aspects: AIS_ASPECTS_6 }), { routes: XC933_FAST_ROUTES, matLimits: { img: 9, vid: 3, aud: 3 } }),
	// 47 线「普通线路」（上游默认线，第216轮；比 48 专线便宜一档，能力同 48）
	ais("xc933-sd2.0-p", "47|seedance-2.0|480p", 2, 30, aisParams({ res: ["480p", "720p", "1080p", "4k"], aspects: AIS_ASPECTS_6 }), { routes: XC933_P_ROUTES, matLimits: { img: 9, vid: 3, aud: 3 } }),
	ais("xc933-sd2.0-fast-p", "47|seedance-2.0-fast|480p", 1.5, 23, aisParams({ res: ["480p", "720p"], aspects: AIS_ASPECTS_6 }), { routes: XC933_FAST_P_ROUTES, matLimits: { img: 9, vid: 3, aud: 3 } }),
	// 53 线「限时特惠·漫剧优选（卡人脸）」（第162轮；按秒，比 47/48 线便宜）：**全系首尾帧 + 6 比例**；
	// ⚠「卡人脸」=真人素材可能被卡审（运营侧知悉）
	ais("xc933-sd2.0-mj", "53|seedance-2.0|480p", 2, 30, aisParams({ res: ["480p", "720p", "1080p"], aspects: AIS_ASPECTS_6 }), { routes: XC933_MJ_ROUTES, methods: ["omni", "frames"], matLimits: { img: 9, vid: 3, aud: 3 } }),
	ais("xc933-sd2.0-fast-mj", "53|seedance-2.0-fast|480p", 1.5, 23, aisParams({ res: ["480p", "720p"], aspects: AIS_ASPECTS_6 }), { routes: XC933_FAST_MJ_ROUTES, methods: ["omni", "frames"], matLimits: { img: 9, vid: 3, aud: 3 } }),
	// 50 线「限时特价（不卡人脸）·按条」→ 我们侧按次固定占位价；2026-08-09 起 sd2.0 时长放宽 4-15、5 比例
	ais("xc933-sd2.0-c", "50|seedance-2.0|720p", null, 45, aisParams({ aspects: AIS_ASPECTS_5 }), { matLimits: { img: 9, vid: 3, aud: 3 } }),
	ais("xc933-sd2.0-fast-c", "50|seedance-2.0-fast|720p", null, 35, aisParams({ aspects: AIS_ASPECTS_5 }), { matLimits: { img: 9, vid: 3, aud: 3 } }),
	// 49 线「按条计费」（第216轮；**全系首尾帧**）：sd2.0 720p/1080p 双档；fast 720p 单档
	ais("xc933-sd2.0-c2", "49|seedance-2.0|720p", null, 72, aisParams({ res: ["720p", "1080p"], aspects: AIS_ASPECTS_6 }), {
		routes: [{ when: { resolution: "1080p" }, upstreamModel: "49|seedance-2.0|1080p", cost: 99 }],
		methods: ["omni", "frames"], matLimits: { img: 9, vid: 3, aud: 3 },
	}),
	ais("xc933-sd2.0-fast-c2", "49|seedance-2.0-fast|720p", null, 60, aisParams({ aspects: AIS_ASPECTS_6 }), { methods: ["omni", "frames"], matLimits: { img: 9, vid: 3, aud: 3 } }),
	// 58 线「720P 限时·按条」（第216轮）：fast 单模型、时长离散档 5/10/15、图9 视0 音0；⚠「卡人脸 慎用」
	ais("xc900-sd2.0-fast", "58|seedance-2.0-fast|720p", null, 20, aisParams({ durOpts: [5, 10, 15], aspects: ["16:9", "9:16", "1:1", "21:9", "4:3"] }), { matLimits: { img: 9, vid: 0, aud: 0 } }),
	// 54 线「Seedance 2.5（官方超低价补贴）」（第216轮）：**图30 视10 音10、4-30s**（素材量超三位数字惯例，名不编码）
	ais("xc-sd2.5", "54|seedance-2.5|480p", 3, 90, aisParams({ res: ["480p", "720p"], durMax: 30, aspects: AIS_ASPECTS_3 }), { routes: XC_SD25_ROUTES, matLimits: { img: 30, vid: 10, aud: 10 } }),
	// 59 线「海螺 MiniMax H3（不卡人脸）」（第216轮）：图9 视0 音3、5-15s
	ais("xc903-minimax-h3", "59|minimax-h3|480p", 1, 15, aisParams({ res: ["480p", "720p"], durMin: 5, aspects: AIS_HV }), { routes: XC_H3_ROUTES, matLimits: { img: 9, vid: 0, aud: 3 } }),
	// 51 线「Grok（全分辨率）」（按次占位价；2026-08-09 能力大改：两款均支持纯文生（needImage 移除）、
	// 1.0 时长连续 1-15s + 7 比例、1.5 图上限 1→7、5-15s、双比例）
	ais("xc700-grok1.0", "51|grok-imagine-video-1.0|720p", null, 12, aisParams({ durMin: 1, aspects: AIS_GROK_ASPECTS }), { matLimits: { img: 7, vid: 0, aud: 0 } }),
	ais("xc100-grok1.5", "51|grok-imagine-video-1.5|720p", null, 15, aisParams({ durMin: 5, aspects: AIS_HV }), { matLimits: { img: 7, vid: 0, aud: 0 } }),
	// 56 线「快乐马 HappyHorse」（第216轮，新家族；**仅图生视频**、图9、3-15s）
	ais("xc900-hh1.0", "56|happyhorse-1.0|720p", 2, 30, aisParams({ res: ["720p", "1080p"], durMin: 3, aspects: AIS_ASPECTS_5 }), { routes: XC_HH10_ROUTES, matLimits: { img: 9, vid: 0, aud: 0 } }),
	ais("xc900-hh1.1", "56|happyhorse-1.1|720p", 2.5, 38, aisParams({ res: ["720p", "1080p"], durMin: 3, aspects: AIS_ASPECTS_5 }), { routes: XC_HH11_ROUTES, matLimits: { img: 9, vid: 0, aud: 0 } }),
	// 60 线「可灵 Kling V3」（第216轮；**仅图生视频**、图3、3-15s）
	ais("xc300-kling3", "60|kling-v3|720p", 1.5, 23, aisParams({ res: ["720p", "1080p"], durMin: 3, aspects: AIS_HV }), { routes: XC_KLING_ROUTES, matLimits: { img: 3, vid: 0, aud: 0 } }),
	// 21 线「Gemini Omni Flash」（第216轮重接；旧 xc600-gemini-flash 在墓碑不复活 → 新 id）：图6、固定 10s、按条
	ais("xc600-gemini-omni", "21|gemini-omni-flash|720p", null, 15, aisParams({ durOpts: [10], aspects: AIS_HV }), { matLimits: { img: 6, vid: 0, aud: 0 } }),
	// 星辰图片 5 款（第162轮 52/46/23；第216轮 +55 High 档）：占位价=上游积分量级
	aisImg("xc-gpt-image-2-high", "55|gpt-image-2", { oneK: 8, twoK: 11, fourK: 19 }, 9, AIS_IMG_ASPECTS_5),
	aisImg("xc-gpt-image-2", "52|gpt-image-2", { oneK: 6, twoK: 8, fourK: 16 }, 9, AIS_IMG_ASPECTS_5),
	aisImg("xc-gpt-image-2-low", "46|gpt-image-2", { oneK: 5, twoK: 7, fourK: 11 }, 6, AIS_IMG_ASPECTS_8),
	aisImg("xc-nano-banana-pro", "23|gemini-3-pro-image-preview", { oneK: 10, twoK: 12, fourK: 20 }, 7, AIS_IMG_ASPECTS_5),
	aisImg("xc-nano-banana-2", "23|gemini-3.1-flash-image-preview", { oneK: 6, twoK: 8, fourK: 18 }, 7, AIS_IMG_ASPECTS_5),
	// ── 画影（AI-Studio aixyzz）6 模型（第133轮）：命名按素材量；线路能力/守卫见 translators/huaying.ts ──
	// 按秒线（上游 per_second 0.61-0.72 POINT/秒）
	hy("hy933-sd2.0", "seedance2.0-xs", hyParams(["720p", "1080p", "4k"], HY_ASPECTS_6), 45, 3),
	hy("hy903-sd2.0", "video-seedance-2.0-vip", hyParams(["720p", "1080p"], HY_ASPECTS_6), 45, 3),
	hy("hy903-sd2.0-fast", "video-seedance-2.0-fast-vip", hyParams(["720p"], HY_ASPECTS_6), 30, 2),
	// 按条线（上游 per_item 5/5.4 POINT/条，价与时长无关 → 我们侧按次固定占位价）
	hy("hy900-sd2.0", "seedance-2.0-ai", hyParams(["720p"], ["16:9", "9:16"]), 45),
	hy("hy431-sd2.0", "seedance-2.0-yo", hyParams(["480p", "720p"], HY_ASPECTS_3), 45),
	hy("hy431-sd2.0-fast", "seedance-2.0-fast-yo", hyParams(["480p", "720p"], HY_ASPECTS_3), 30),
	// ── Dimensio（jimeng.dimensio.cn）3 模型（第134轮）：命名按素材量（全线 933）；守卫见 translators/dimensio.ts ──
	dm("dm933-sd2.0", "jimeng-video-seedance-2.0-vip", ["720p", "1080p"], 3, 45, {
		routes: [{ when: { resolution: "1080p" }, upstreamModel: "jimeng-video-seedance-2.0-vip", cost: 113, costPerUnit: 7.5 }],
	}),
	dm("dm933-sd2.0-fast", "jimeng-video-seedance-2.0-fast-vip", ["720p"], 2.5, 38),
	dm("dm933-sd2.0-mini", "jimeng-video-seedance-2.0-mini", ["720p"], 2, 30),
	// ── Aivide 2.0（aivideo.beauty）1 模型（第139轮）：命名按素材量（933，视+音合计≤3）；守卫见 translators/aivide.ts ──
	def("av933-2.0", "av933-2.0", "video", "aivide-video", AV_PARAMS, 45, {
		channelId: CH_AIVIDE, upstreamModel: "aivide-2.0", modeId: "aivide",
		costField: "duration", costPerUnit: 3,
	}),
	// ── 简梦P 3 模型（第147轮；第242轮 +H3video-2k −Sora 系；同轮补充恢复 gemini/veo 两款）：外显名=上游公开模型名；能力/守卫见 translators/jianmengp.ts ──
	jmp("H3video-2k", jmpH3Params(), 5, 75, { img: 9, vid: 3, aud: 3 }, "fam-minimax"),
	jmp("gemini-omni-flash", jmpGeminiParams(), 3, 30, { img: 5, vid: 1, aud: 0 }),
	jmp("veo31-fast", jmpVeoParams(), 2, 16, { img: 2, vid: 0, aud: 0 }),
	// ── 简梦M（MuseAI）4 模型（第151轮）：命名按素材量（K=403 / HU=933）；守卫见 translators/musem.ts ──
	jmm("jmm403-sd2.0", "MUSE_SD2_PRO_K", 48, { img: 4, vid: 0, aud: 3 }),
	jmm("jmm403-sd2.0-fast", "MUSE_SD2_FAST_K", 40, { img: 4, vid: 0, aud: 3 }),
	jmm("jmm933-sd2.0", "MUSE_SD2_PRO_HU_0710", 60, { img: 9, vid: 3, aud: 3 }),
	jmm("jmm933-sd2.0-fast", "MUSE_SD2_FAST_HU_0710", 45, { img: 9, vid: 3, aud: 3 }),
	// ── 简梦Z（zexitongxue.com）14 模型（第152轮）：实时目录 can_use=true 全接（4k 维护中不接）；
	//    豆包三线带首尾帧方法；⚠ dolo 与 720p-pro-431 目录 note 显示线路异常（维护中/无启用线路）但 can_use=true——
	//    照文档「只提交 can_use=true」接入，运营上线前复核（异常单上游明确报错+自动退款，无静默风险）──
	jmz("jmz-dolo", "dolo", jmzParams("720p", jmzDurRange(1, 15, 10)), 15, { img: 9 }),
	jmz("jmz-dolo-2", "dolo-2", jmzParams("720p", jmzDurOpts([5, 15], 5)), 10, { img: 9 }),
	jmz("jmz-grok", "grok", jmzParams("720p", jmzDurOpts([6, 10, 15], 6)), 6, { img: 9, vid: 0, aud: 0 }),
	jmz("jmz-seedance-2.0-480p-pro", "seedance-2.0-480p-pro", jmzParams("480p", jmzDurOpts([5, 10, 15], 5)), 40, { img: 9, vid: 0, aud: 0 }),
	jmz("jmz-seedance-2.0-480p-pro2", "seedance-2.0-480p-pro2", jmzParams("480p", jmzDurRange(4, 15, 5)), 45, { img: 9 }, { perUnit: 3 }),
	jmz("jmz-seedance-2.0-720p-pro", "seedance-2.0-720p-pro", jmzParams("720p", jmzDurRange(4, 15, 5)), 60, { img: 9 }, { perUnit: 4 }),
	jmz("jmz-seedance-2.0-720-pro-enhance", "seedance-2.0-720-pro-enhance", jmzParams("720p", jmzDurRange(4, 12, 4)), 48, { img: 9 }, { perUnit: 4 }),
	jmz("jmz-seedance-2.0-720p-pro-431", "seedance-2.0-720p-pro-431", jmzParams("720p", jmzDurRange(4, 15, 5)), 45, { img: 4 }),
	jmz("jmz-seedance-fast-2.0-480p-pro", "seedance-fast-2.0-480p-pro", jmzParams("480p", jmzDurRange(4, 15, 5)), 30, { img: 9 }, { perUnit: 2 }),
	jmz("jmz-seedance-fast-2.0-720p-pro", "seedance-fast-2.0-720p-pro", jmzParams("720p", jmzDurRange(4, 15, 5)), 45, { img: 9 }, { perUnit: 3 }),
	jmz("jmz-seedance-fast-2.0-720p-pro-431", "seedance-fast-2.0-720p-pro-431", jmzParams("720p", jmzDurOpts([4], 4)), 30, { img: 4 }),
	jmz("jmz-doubao-seedance-2-0-480p", "doubao-seedance-2-0-480p", jmzParams("480p", jmzDurRange(4, 15, 5)), 150, { img: 9, vid: 3, aud: 5 }, { perUnit: 10, extra: { methods: ["omni", "frames"] } }),
	jmz("jmz-doubao-seedance-2-0-720p", "doubao-seedance-2-0-720p", jmzParams("720p", jmzDurRange(4, 15, 5)), 300, { img: 9, vid: 3, aud: 5 }, { perUnit: 20, extra: { methods: ["omni", "frames"] } }),
	jmz("jmz-doubao-seedance-2-0-1080p", "doubao-seedance-2-0-1080p", jmzParams("1080p", jmzDurRange(4, 15, 5)), 675, { img: 9, vid: 3, aud: 5 }, { perUnit: 45, extra: { methods: ["omni", "frames"] } }),
	// ── 简梦Z 图片 7 款（第153轮）：文档「有效生图模型」表全接（外显名=展示名 kebab 化加 jmz- 前缀，上游发实名）──
	jmzImg("jmz-gpt-image-2", "gpt-image-2", [jmzImgRes(), JMZ_GPT_IMG_SIZE], 7, 14),
	jmzImg("jmz-nano-banana-pro", "gemini-3-pro-image-preview", [jmzImgRes()], 9, 4),
	jmzImg("jmz-nano-banana-2", "gemini-3.1-flash-image-preview", [jmzImgRes()], 9, 4),
	jmzImg("jmz-grok-imagine-image", "grok-imagine-image", [], 3, 1),
	jmzImg("jmz-grok-imagine-image-pro", "grok-imagine-image-pro", [], 5, 1),
	jmzImg("jmz-grok-imagine-image-lite", "grok-imagine-image-lite", [], 2, 0),
	jmzImg("jmz-grok-imagine-image-edit", "grok-imagine-image-edit", [], 5, 3),
	// ── 简梦T（llm.chre3.com）1 模型（第160轮）：命名按素材量（933）；守卫/合规参数见 translators/jmt.ts ──
	def("jmt933-sd2.0", "jmt933-sd2.0", "video", "jmt-video", JMT_PARAMS, 45, {
		channelId: CH_JMT, upstreamModel: "sd2-c8", modeId: "jmt",
		costField: "duration", costPerUnit: 3, matLimits: { img: 9, vid: 3, aud: 3 },
	}),
	// ── 简梦F（new.vosle.xyz）1 模型（第161轮）：命名按素材量（933）；模型 ID 现拼/守卫见 translators/jmf.ts ──
	def("jmf933-sd2.0", "jmf933-sd2.0", "video", "jmf-video", JMF_PARAMS, 45, {
		channelId: CH_JMF, upstreamModel: "seedance-2.0", modeId: "jmf",
		methods: ["omni", "frames"], costField: "duration", costPerUnit: 3, matLimits: { img: 9, vid: 3, aud: 3 },
	}),
	// ── 出海营（overseas）5 模型（第186轮）：命名按素材量（933）；分辨率经 routes 重定向上游后缀款 ──
	os("os933-sd2.0", "doubao-seedance-2-0-260128", ["720p", "1080p", "4k"], 3, 45, {
		routes: [
			{ when: { resolution: "1080p" }, upstreamModel: "doubao-seedance-2-0-260128-1080p", cost: 68, costPerUnit: 4.5 },
			{ when: { resolution: "4k" }, upstreamModel: "doubao-seedance-2-0-260128-4k", cost: 90, costPerUnit: 6 },
		],
	}),
	os("os933-sd2.0-fast", "doubao-seedance-2-0-fast-260128", ["720p", "480p"], 2, 30, {
		routes: [{ when: { resolution: "480p" }, upstreamModel: "doubao-seedance-2-0-fast-260128-480p", cost: 23, costPerUnit: 1.5 }],
	}),
	os("os933-sd2.0-mini", "doubao-seedance-2-0-mini-260615", ["720p"], 1.5, 23),
	// sd-2-5 时长可到 30s（第187轮用户实锤）；兜底价=每秒价×30「默认按最高」
	os("os933-sd2.5", "sd-2-5", ["720p", "480p"], 3, 90, {
		routes: [{ when: { resolution: "480p" }, upstreamModel: "sd-2-5-480p", cost: 60, costPerUnit: 2 }],
	}, 30),
	// gemini-omni（同接口调用；mode t2v/r2v/edit 翻译器按素材自动定 → 无「方法」下拉；4/6/8/10 就档由上游完成）
	def("os-gemini-omni", "os-gemini-omni", "video", "overseas-video", OS_GEMINI_PARAMS, 30, {
		channelId: CH_OVERSEAS, upstreamModel: "gemini-omni", modeId: "overseas",
		costField: "duration", costPerUnit: 3, matLimits: { img: 5, vid: 1, aud: 0 },
	}),
	// ── 算力（xienlive.com · OctopusAI）1 模型（第217轮）：MINIMAX_H3 音视频同步生成（4-15s、
	//    480p/720p/1080p 原生 + 4k=720p 超分；支持 参考图/视频/音频（音频须伴图或视）+ 首尾帧）。
	//    分辨率是普通请求参数（非模型编码）→ routes 只换价不换上游名；素材上限文档未给=933 惯例值。
	//    按秒**占位价**（上游 元/秒 0.12/0.25/0.62/1.27，含视频参考另有折扣价——我方单一档保守按无视频档折算），
	//    上线前管理端定真价。守卫/引用转写（<<<N>>> 0 基下标）见 translators/suanli.ts。
	def("sl933-minimax-h3", "sl933-minimax-h3", "video", "suanli-video", [
		{ key: "resolution", label: "分辨率", type: "enum", options: ["480p", "720p", "1080p", "4k"], default: "480p" },
		{ key: "duration", label: "时长", type: "number", default: 15, min: 4, max: 15, step: 1, unit: "s" },
		{ key: "aspect_ratio", label: "宽高比", type: "enum", options: ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"], default: "16:9" },
	], 15, {
		channelId: CH_SUANLI, upstreamModel: "MINIMAX_H3", modeId: "suanli",
		costField: "duration", costPerUnit: 1,
		routes: [
			{ when: { resolution: "480p" }, upstreamModel: "MINIMAX_H3", cost: 15, costPerUnit: 1 },
			{ when: { resolution: "720p" }, upstreamModel: "MINIMAX_H3", cost: 30, costPerUnit: 2 },
			{ when: { resolution: "1080p" }, upstreamModel: "MINIMAX_H3", cost: 75, costPerUnit: 5 },
			{ when: { resolution: "4k" }, upstreamModel: "MINIMAX_H3", cost: 150, costPerUnit: 10 },
		],
		methods: ["omni", "frames"], matLimits: { img: 9, vid: 3, aud: 3 },
	}),
	// ── 简梦H（ZhengAPI）图片 6 款（第154轮）：外显名=展示名 kebab 化加 jmh- 前缀，上游发实名/基名 ──
	jmh("jmh-grok-imagine", "grok-imagine-1.0", [], 5, 1),
	jmh("jmh-grok-imagine-edit", "grok-imagine-1.0-edit", [], 5, 1),
	jmh("jmh-nano-banana", "firefly-nano-banana", [jmhImgRes()], 8),
	jmh("jmh-nano-banana-pro", "firefly-nano-banana-pro", [jmhImgRes()], 12),
	jmh("jmh-nano-banana-2", "firefly-nano-banana2", [jmhImgRes()], 9),
	jmh("jmh-gpt-image", "firefly-gpt-image", [jmhImgRes()], 10),
	// ── 简梦H 视频 9 款（第155轮）：统一视频文档全家族接入（grok≤7 图/veo31 系首尾帧/kling3 恒 15s）──
	jmhVid("jmh-grok-video", "grok-imagine-1.0-video", jmhVidParams(["720p", "480p"], jmzDurOpts([6, 10], 6), ["16:9", "9:16", "3:2"]), 3, 30, 7),
	jmhVid("jmh-sora2", "firefly-sora2", jmhVidParams(null, jmzDurOpts([4, 8, 12], 12), ["16:9", "9:16"]), 3, 36),
	jmhVid("jmh-sora2-pro", "firefly-sora2-pro", jmhVidParams(null, jmzDurOpts([4, 8, 12], 12), ["16:9", "9:16"]), 5, 60),
	jmhVid("jmh-veo31", "firefly-veo31", jmhVidParams(["1080p", "720p"], jmzDurOpts([4, 6, 8], 8), ["16:9", "9:16"]), 4, 32, 2, { methods: ["omni", "frames"] }),
	jmhVid("jmh-veo31-ref", "firefly-veo31-ref", jmhVidParams(["1080p", "720p"], jmzDurOpts([4, 6, 8], 8), ["16:9", "9:16"]), 4, 32, 3),
	jmhVid("jmh-veo31-fast", "firefly-veo31-fast", jmhVidParams(["1080p", "720p"], jmzDurOpts([4, 6, 8], 8), ["16:9", "9:16"]), 3, 24, 2, { methods: ["omni", "frames"] }),
	jmhVid("jmh-kling3", "firefly-kling3", jmhVidParams(["1080p", "720p"], jmzDurOpts([15], 15), ["16:9", "9:16"]), 4, 60, 2, { methods: ["omni", "frames"] }),
	jmhVid("jmh-kling3-omni", "firefly-kling3omni", jmhVidParams(["1080p", "720p"], jmzDurOpts([5, 8, 10], 10), ["16:9", "9:16"]), 4, 40),
	jmhVid("jmh-runway45", "firefly-runway45", jmhVidParams(["720p"], jmzDurOpts([5, 10], 10), ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "9:21"]), 4, 40),
	// ── 火山引擎 AI MediaKit：视频超分（4 种）+ 去字幕（精细化版）。upstreamModel = 工具端点路径
	//    （enhance-video 用 ":standard/:professional" 后缀区分 tool_version）；密钥/地址在「火山引擎 MediaKit」渠道配置。
	def("volc-enhance-generative", "超分·大模型", "video-enhance", "volc-mediakit", VOLC_ENHANCE_GEN_PARAMS, 40, {
		channelId: CH_VOLC, upstreamModel: "enhance-video-generative",
	}),
	def("volc-enhance-fast", "超分·极速版", "video-enhance", "volc-mediakit", VOLC_ENHANCE_FAST_PARAMS, 10, {
		channelId: CH_VOLC, upstreamModel: "enhance-video-fast",
	}),
	def("volc-enhance-standard", "超分·标准版", "video-enhance", "volc-mediakit", VOLC_ENHANCE_STD_PARAMS, 15, {
		channelId: CH_VOLC, upstreamModel: "enhance-video:standard",
	}),
	def("volc-enhance-professional", "超分·专业版", "video-enhance", "volc-mediakit", VOLC_ENHANCE_PRO_PARAMS, 25, {
		channelId: CH_VOLC, upstreamModel: "enhance-video:professional",
	}),
	def("volc-erase-subtitle", "去字幕·精细化版", "video-erase", "volc-mediakit", VOLC_ERASE_PARAMS, 20, {
		channelId: CH_VOLC, upstreamModel: "erase-video-subtitle-pro",
	}),
	def("volc-image-enhance", "图像超分（画质增强）", "image-enhance", "volc-mediakit", VOLC_IMG_ENHANCE_PARAMS, 10, {
		channelId: CH_VOLC, upstreamModel: "enhance-image",
	}),
	// ── Yali（api.yaliai.com）图片 4 款（第229轮）：接口类型决定渠道归属，两类 Key 各自填 ──
	yali("yali-gpt-image-2", "gpt-image-2", CH_YALI_OPENAI, [yaliRes(["1k", "2k", "4k"], "2k"), YALI_OPENAI_SIZE, YALI_QUALITY], 8),
	yali("yali-gemini-2.5-flash-image", "gemini-2.5-flash-image-preview", CH_YALI_GEMINI, [yaliRes(["1k"], "1k"), yaliSize(YALI_GEMINI_RATIOS)], 5),
	yali("yali-gemini-3-pro-image", "gemini-3-pro-image-preview", CH_YALI_GEMINI, [yaliRes(["1k", "2k", "4k"], "2k"), yaliSize(YALI_GEMINI_RATIOS)], 10),
	// 3.1 Flash：比例档最全（+1:4/1:8/4:1/8:1）；512 档不开（非 OpenAI Images 规格，见上方注释）
	yali("yali-gemini-3.1-flash-image", "gemini-3.1-flash-image-preview", CH_YALI_GEMINI, [yaliRes(["1k", "2k", "4k"], "2k"), yaliSize([...YALI_GEMINI_RATIOS, "1:4", "1:8", "4:1", "8:1"])], 9),
	// ── Skylee（api.808relay.com）图片 12 款（第230轮）：站点图片模型清单全接；上游名逐字照抄 ──
	sky("sky-gpt-image-2", "gpt-image-2", [SKY_GPT_SIZE, SKY_GPT_QUALITY], 23, 14),
	sky("sky-gpt-image-2-low", "gpt-image-2-low", [SKY_GPT_SIZE, SKY_GPT_QUALITY], 7, 14),
	sky("sky-gpt-image-2-compact", "gpt-image-2-openai-compact", [SKY_GPT_SIZE, SKY_GPT_QUALITY], 15, 14),
	// 按 Token 计费款：与次数非线性对应，按最贵档保守占位（务必真单对账）
	sky("sky-gpt-image-2-token", "gpt-image-2-token", [SKY_GPT_SIZE, SKY_GPT_QUALITY], 23, 14),
	sky("sky-gemini-3-pro-image", "gemini-3-pro-image-preview", [skyRes(), skySize()], 16, 4),
	sky("sky-gemini-3.1-flash-image", "gemini-3.1-flash-image-preview", [skyRes(), skySize()], 16, 4),
	// [zz] 廉价平行线（同款模型、站方另一条线路）——上游名带方括号，逐字照抄
	sky("sky-gemini-3-pro-image-zz", "[zz]gemini-3-pro-image-preview", [skyRes(), skySize()], 12, 4),
	sky("sky-gemini-3.1-flash-image-zz", "[zz]gemini-3.1-flash-image-preview", [skyRes(), skySize()], 9, 4),
	// ⚠ 上游名 `[zz]` 后有一个空格（站点清单原样）；且该款未列 images 接口——见上方注释，需真单复核
	sky("sky-gemini-3.1-flash-lite-image-zz", "[zz] gemini-3.1-flash-lite-image", [skyRes(), skySize()], 7, 4),
	// Midjourney：一次任务返四张图（本管线落第一张）；价目按上游账号档位分四档，此处按 Relax 标准占位
	sky("sky-midjourney-v7", "midjourney-v7", [skySize()], 40, 5),
	sky("sky-midjourney-v8.1", "midjourney-v8.1", [skySize()], 40, 5),
	sky("sky-midjourney-v8.2", "midjourney-v8.2", [skySize()], 40, 5),
	// ── congge（congchen.top）图片 3 款（第233轮）：上游名照抄站点清单 ──
	cgImg("cg-gpt-image-2", "gpt-image-2", [CG_IMG_RES(["1k", "2k"]), CG_IMG_QUALITY], 10), // ⚠ 不支持 4K（上游明确报错）
	cgImg("cg-gemini-3-pro-image", "gemini-3-pro-image", [CG_IMG_RES(["1k", "2k", "4k"])], 10),
	cgImg("cg-gemini-3.1-flash-image", "gemini-3.1-flash-image-preview", [CG_IMG_RES(["1k", "2k", "4k"])], 10),
	// ── congge 视频 4 款（第233轮）：分辨率经 routes 重定向到上游真名（⚠ 名字里的空格与大小写照抄，勿"顺手规范化"）──
	cgVid("cg933-sd2.0-mini", "seedance2.0 Mini-720p", ["480p", "720p"], 15, 30, [
		{ when: { resolution: "480p" }, upstreamModel: "seedance2.0 Mini-480p", cost: 300, costPerUnit: 20 },
		{ when: { resolution: "720p" }, upstreamModel: "seedance2.0 Mini-720p", cost: 450, costPerUnit: 30 },
	], CG_MAT_20),
	cgVid("cg933-sd2.0-fast", "seedance2.0 Fast-720p", ["480p", "720p"], 15, 40, [
		{ when: { resolution: "480p" }, upstreamModel: "seedance2.0 Fast-480p", cost: 375, costPerUnit: 25 },
		{ when: { resolution: "720p" }, upstreamModel: "seedance2.0 Fast-720p", cost: 600, costPerUnit: 40 },
	], CG_MAT_20),
	cgVid("cg933-sd2.0", "seedance2.0 2.0-720p", ["480p", "720p", "1080p"], 15, 50, [
		{ when: { resolution: "480p" }, upstreamModel: "seedance2.0 2.0-480p", cost: 630, costPerUnit: 42 },
		{ when: { resolution: "720p" }, upstreamModel: "seedance2.0 2.0-720p", cost: 750, costPerUnit: 50 },
		{ when: { resolution: "1080p" }, upstreamModel: "seedance2.0 2.0-1080p", cost: 1065, costPerUnit: 71 },
	], CG_MAT_20),
	// 2.5：最长 30 秒、素材 图30/视10/音10（文档「二、公开模型」）
	cgVid("cg-sd2.5", "seedance2.5 720p", ["480p", "720p"], 30, 60, [
		{ when: { resolution: "480p" }, upstreamModel: "seedance2.5 480p", cost: 1110, costPerUnit: 37 },
		{ when: { resolution: "720p" }, upstreamModel: "seedance2.5 720p", cost: 1800, costPerUnit: 60 },
	], CG_MAT_25),
	// ── autodl（autodl.art）视频 3 款（第234轮）：⚠ 部署后逐模型把「上游模型名」改成真实 workflow_id ──
	adl("adl-minimax-h3", "autodl·H3 多图参考", ADL_RES_ALL, 3, { img: 9, vid: 0, aud: 0 }),
	adl("adl-minimax-h3-t2v", "autodl·H3 文生视频", ADL_RES_BASE, 2, { img: 0, vid: 0, aud: 0 }),
	// 首尾帧工作流：仅 frames 方法（客户端「方法」下拉只此一项）；素材=首帧+尾帧两张图
	adl("adl-minimax-h3-flf", "autodl·H3 首尾帧", ADL_RES_BASE, 2, { img: 2, vid: 0, aud: 0 }, { methods: ["frames"] }),
	// ── 奇迹云（自建实例池）1 款（第249轮）：⚠ 上游模型名=工作流骨架名 jianyi933，管理端勿改 ──
	qjc("qj933-minimax-h3", "MiniMax H3"),
	// ── BYS（www.boyesir.icu）视频 15 款（第252轮）：按秒 8 款 ─────────────────────
	// Seedance 2.0 Mini：上游 0.31/0.43 元每秒（480p/720p），4–12s
	bysSec("bys900-sd2.0-mini", "BYS·Seedance 2.0 Mini", "seedance-2.0-mini",
		[bysRes(["480p", "720p"], "720p"), bysDur(4, 12), BYS_RATIO], 43, 12, [
			{ when: { resolution: "480p" }, upstreamModel: "seedance-2.0-mini", cost: 372, costPerUnit: 31 },
			{ when: { resolution: "720p" }, upstreamModel: "seedance-2.0-mini", cost: 516, costPerUnit: 43 },
		], 9),
	// Seedance 2.0 Fast：0.54/0.75/1.6 元每秒（480p/720p/1080p），4–12s
	bysSec("bys900-sd2.0-fast", "BYS·Seedance 2.0 Fast", "seedance-fast-2.0",
		[bysRes(["480p", "720p", "1080p"], "720p"), bysDur(4, 12), BYS_RATIO], 75, 12, [
			{ when: { resolution: "480p" }, upstreamModel: "seedance-fast-2.0", cost: 648, costPerUnit: 54 },
			{ when: { resolution: "720p" }, upstreamModel: "seedance-fast-2.0", cost: 900, costPerUnit: 75 },
			{ when: { resolution: "1080p" }, upstreamModel: "seedance-fast-2.0", cost: 1920, costPerUnit: 160 },
		], 9),
	// Seedance 2.0 满血：0.4/0.65/1.1/2.4 元每秒（480p/720p/1080p/4K），4–15s——全站四档最便宜的一条线
	bysSec("bys900-sd2.0", "BYS·Seedance 2.0", "dvc-seedance-2.0",
		[bysRes(["480p", "720p", "1080p", "4k"], "720p"), bysDur(4, 15), BYS_RATIO], 65, 15, [
			{ when: { resolution: "480p" }, upstreamModel: "dvc-seedance-2.0", cost: 600, costPerUnit: 40 },
			{ when: { resolution: "720p" }, upstreamModel: "dvc-seedance-2.0", cost: 975, costPerUnit: 65 },
			{ when: { resolution: "1080p" }, upstreamModel: "dvc-seedance-2.0", cost: 1650, costPerUnit: 110 },
			{ when: { resolution: "4k" }, upstreamModel: "dvc-seedance-2.0", cost: 3600, costPerUnit: 240 },
		], 9),
	// Seedance 2.0 特惠：0.65/0.75/0.85/0.85 元每秒（720p/1080p/2K/4K），4–12s——2K/4K 同价，高分辨率最划算
	bysSec("bys900-sd2.0-special", "BYS·Seedance 2.0 特惠", "sd_2.0_special",
		[bysRes(["720p", "1080p", "2k", "4k"], "720p"), bysDur(4, 12), BYS_RATIO], 65, 12, [
			{ when: { resolution: "720p" }, upstreamModel: "sd_2.0_special", cost: 780, costPerUnit: 65 },
			{ when: { resolution: "1080p" }, upstreamModel: "sd_2.0_special", cost: 900, costPerUnit: 75 },
			{ when: { resolution: "2k" }, upstreamModel: "sd_2.0_special", cost: 1020, costPerUnit: 85 },
			{ when: { resolution: "4k" }, upstreamModel: "sd_2.0_special", cost: 1020, costPerUnit: 85 },
		], 9),
	// Seedance 2.0 高清：0.78/0.85/0.95/1 元每秒（720p/1080p/2K/4K），4–15s
	// ⚠ 该线分辨率**编在上游模型名里** → routes 逐档换真名（外显只有一个模型）
	bysSec("bys900-sd2.0-hd", "BYS·Seedance 2.0 高清（2K/4K）", "sdas-gf-seedance-2.0-720p",
		[bysRes(["720p", "1080p", "2k", "4k"], "1080p"), bysDur(4, 15), BYS_RATIO], 78, 15, [
			{ when: { resolution: "720p" }, upstreamModel: "sdas-gf-seedance-2.0-720p", cost: 1170, costPerUnit: 78 },
			{ when: { resolution: "1080p" }, upstreamModel: "sdas-gf-seedance-2.0-1080p", cost: 1275, costPerUnit: 85 },
			{ when: { resolution: "2k" }, upstreamModel: "sdas-gf-seedance-2.0-2k", cost: 1425, costPerUnit: 95 },
			{ when: { resolution: "4k" }, upstreamModel: "sdas-gf-seedance-2.0-4k", cost: 1500, costPerUnit: 100 },
		], 9),
	// Seedance 2.5：**4–30s**、参考图 10 张
	// ⚠ 单价以**上游 402 报价实测为准**（2026-08-21：480p 0.65 / 720p 1.02 元每秒）——
	//   文档页价目表写的 0.47/0.58 **已过时**，照文档定价会低于成本近一倍（第252轮实测教训）
	bysSec("bys-sd2.5", "BYS·Seedance 2.5", "lec-ac-seedance-2-5",
		[bysRes(["480p", "720p"], "720p"), bysDur(4, 30), BYS_RATIO], 102, 30, [
			{ when: { resolution: "480p" }, upstreamModel: "lec-ac-seedance-2-5", cost: 1950, costPerUnit: 65 },
			{ when: { resolution: "720p" }, upstreamModel: "lec-ac-seedance-2-5", cost: 3060, costPerUnit: 102 },
		], 10),
	// MiniMax H3：0.35 元每秒（720p），6–15s——全站最便宜的 H3
	bysSec("bys900-minimax-h3", "BYS·MiniMax H3", "lec-minimax-h3",
		[bysRes(["720p"], "720p"), bysDur(6, 15), BYS_RATIO], 35, 15, [], 9),
	// Kling 3.0 Turbo：0.85/1/1.15/1.4 元每秒（720p/1080p/2K/4K），4–12s（该站唯一在线的 Kling 线）
	bysSec("bys300-kling3-turbo", "BYS·Kling 3.0 Turbo", "kling-3.0-turbo",
		[bysRes(["720p", "1080p", "2k", "4k"], "1080p"), bysDur(4, 12), BYS_RATIO], 85, 12, [
			{ when: { resolution: "720p" }, upstreamModel: "kling-3.0-turbo", cost: 1020, costPerUnit: 85 },
			{ when: { resolution: "1080p" }, upstreamModel: "kling-3.0-turbo", cost: 1200, costPerUnit: 100 },
			{ when: { resolution: "2k" }, upstreamModel: "kling-3.0-turbo", cost: 1380, costPerUnit: 115 },
			{ when: { resolution: "4k" }, upstreamModel: "kling-3.0-turbo", cost: 1680, costPerUnit: 140 },
		], 3),
	// ── BYS 按次 7 款：价格与时长无关（长镜头更划算），故不设 costField ──────────────
	// 3.5 元/次（2.0 Mini 720p，4–15s）——同底模按次最便宜
	bysOnce("bys900-sd2.0-mini-x", "BYS·Seedance 2.0 Mini（按次）", "mindou-seedance-video",
		[bysRes(["720p"], "720p"), bysDur(4, 15), BYS_RATIO], 350, 9),
	// 3.5 元/次（2.0 Fast 720p，10/15s）
	bysOnce("bys900-sd2.0-fast-x", "BYS·Seedance 2.0 Fast（按次）", "lec-seedance-fast-ht-720p",
		[bysRes(["720p"], "720p"), bysDur(10, 15), BYS_RATIO], 350, 9),
	// 5.5 元/次（满血 933 720p，**4–29s 且不卡人脸**）——长镜头首选
	bysOnce("bys900-sd2.0-pro", "BYS·Seedance 2.0 满血 · 不卡人脸", "seedance2.0",
		[bysRes(["720p"], "720p"), bysDur(4, 29, 15), BYS_RATIO], 550, 9),
	// 933 稳定版，4–15s。⚠ 实测 5.5 元/次（文档写 4.2 已过时，同第252轮 2.5 那款的教训）
	bysOnce("bys900-sd2.0-stable", "BYS·Seedance 2.0 稳定版", "lec-seedance-2-0-933-stable",
		[bysDur(4, 15), BYS_RATIO], 550, 9),
	// 5.3 元/次（2.5 十图、不卡人脸，固定 30s）⚠ 上游名带中文，逐字照抄
	bysOnce("bys-sd2.5-10img", "BYS·Seedance 2.5 十图 · 不卡人脸", "seedance2.5-10图",
		[bysDur(30, 30), BYS_RATIO], 530, 10),
	// 4.5 元/次（MiniMax H3 2K，固定 15s）
	bysOnce("bys900-minimax-h3-2k", "BYS·MiniMax H3 2K", "lec-h3video-2k",
		[bysRes(["2k"], "2k"), bysDur(15, 15), BYS_RATIO], 450, 9),
	// 4.0 元/次（Gemini Omni Flash 扩展版，固定时长）
	bysOnce("bys500-gemini-omni-flash", "BYS·Gemini Omni Flash", "omni-flash-ext",
		[bysDur(4, 10), BYS_RATIO], 400, 5),
	// ── QiQi（pidoi.com）视频 2 款（第255轮）：⚠ 上游名逐字照抄（seedace 少一个 n，非 seedance）──
	qiqi("qq933-sd2.0-720p", "QiQi·Seedance 2.0 720p", "seedace-2.0-720p", 50, QIQI_PARAMS, ["omni", "frames"]),
	// 933 真人视频（flat 形态）：固定 15s、不支持尾帧 → 不声明 methods（客户端无「方法」下拉）
	qiqi("qq933-sora-v3-pro", "QiQi·Sora V3 933 真人 720p", "sora-v3-933-pro", 60, QIQI_933_PARAMS),
	// ── 内部虚拟模型：第三方本地渠道（LibTV/即梦）手续费——echo 同步成功即扣 cost；hidden 不进 catalog，
	//    客户端在第三方调用成功后按 id 请求一次完成扣费（管理端「模型」页可调价）。
	def("fee-thirdparty", "第三方渠道手续费", "text", "echo", [], 5, { hidden: true }),
];

/**
 * 模型 → 家族归类一把尺（第163轮，families.ts 注册表 id）。种子 / 存量迁移 ⑤i / createModel 缺省 三处共用。
 * 规则（用户定稿，勿凭空改）：
 *  - 视频：933/431/403/900/903 素材量命名、dolo、aivide、以及**支持全能参考的 sora-v3 系**都是 Seedance 换壳
 *    → fam-seedance；sora2/jmh-sora2（仅图参考）才是真 Sora2；grok/kling/runway/veo/gemini 按名分家。
 *  - 图像：grok 优先判（防 gpt/banana 词误吞）；gpt-image → GPT Image 2；banana/gemini → Nano Banana；
 *    mj/midjourney → MJ（预留家族，暂无模型）。
 *  - hidden 内部计费模型 / 文本 / 处理类（video-enhance 等）不归家族（客户端不折叠这些能力）。
 * 匹配面 = id + upstreamModel + label 拼串小写（管理端自建模型名/上游名任一带特征词即归入）。
 */
function classifyFamily(m: Pick<ModelDef, "id" | "label" | "capability" | "upstreamModel" | "hidden">): string | undefined {
	if (m.hidden) return undefined;
	const s = `${m.id} ${m.upstreamModel ?? ""} ${m.label}`.toLowerCase();
	if (m.capability === "image") {
		if (s.includes("grok")) return "fam-grok-image";
		if (s.includes("gpt-image") || s.includes("gpt image")) return "fam-gpt-image-2";
		if (s.includes("banana") || s.includes("gemini")) return "fam-nano-banana";
		if (/(^|[^a-z])mj([^a-z]|$)/.test(s) || s.includes("midjourney")) return "fam-mj";
		return undefined;
	}
	if (m.capability === "video") {
		if (s.includes("grok")) return "fam-grok";
		// ⚠ minimax/happyhorse 判定必须在下方 seedance 兜底正则（/933|900|903/）之前——
		//   xc903-minimax-h3 / xc900-hh 系的数字段会被兜底误吞进 seedance（第216轮）
		if (s.includes("minimax") || s.includes("hailuo")) return "fam-minimax";
		if (s.includes("happyhorse")) return "fam-happyhorse";
		if (s.includes("kling")) return "fam-kling3";
		if (s.includes("runway")) return "fam-runway45";
		if (s.includes("veo")) return "fam-veo31";
		if (s.includes("sora-v3")) return "fam-seedance"; // 全能参考 sora=seedance（用户实锤）
		if (s.includes("sora")) return "fam-sora2";
		if (s.includes("gemini")) return "fam-gemini-omni";
		if (s.includes("sd2") || s.includes("seedance") || s.includes("dolo") || s.includes("aivide") || /933|431|403|900|903/.test(s)) return "fam-seedance";
		return undefined;
	}
	return undefined;
}
// 内置种子统一归家族（全新库首启即带 familyId；补种新增同样带上）
for (const d of DEFAULT_MODELS) if (d.familyId === undefined) d.familyId = classifyFamily(d);

const BUILTIN_IDS = new Set(DEFAULT_MODELS.map((d) => d.id));

/** 内置模型种子版本：bump 触发一次性"刷新保留模型定义字段"（退役清理不依赖它，见下）*/
const MODELS_SEED_VERSION = 6; // v6：图像模型增加 resolution 档位参数（服务端控制客户端分辨率下拉）（v5：超分帧率 30/60/120）
/**
 * 已退役的旧内置模型 id：**每次启动都强制删除**（不只在 seed bump 时）。
 * 这些是已下线的内置项（占位/旧文本/裸 JA 档），用户已要求清空、永不自动出现；
 * 即便它们曾与 seedVersion≥2 共存（历史竞态/旧进程回写），也会被清掉。不动用户自建模型。
 */
const RETIRED_IDS = [
	"echo-text", "stub-image", "stub-video", "stub-audio",
	"gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex",
	"claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001",
	"gemini-3-pro-image-preview", "gemini-3.1-flash-image-preview",
	"JA-sd2-fast-480", "JA-sd2-fast-720", "JA-sd2-pro-480", "JA-sd2-pro-720",
	"JA-sd2-fast-15s", "JA-sd2-pro-15s", "JA-sd2-pro-1080p",
];
const RETIRED = new Set(RETIRED_IDS);
/** 刷新内置模型时覆盖的"定义性"字段（保留 enabled / createdAt；显式清空 baseUrl/apiKey 覆盖） */
const MODEL_REFRESH_FIELDS: (keyof ModelDef)[] = [
	"label", "capability", "protocol", "channelId", "upstreamModel", "routes", "params", "cost", "costField", "costPerUnit", "baseUrl", "apiKey", "methods", "officialAssets", "refVideoSecondsWeight",
];

let store: Store = loadJson<Store>(FILE, { version: 0, models: [] });
if (store.models.length === 0) {
	store = { version: 1, seedVersion: MODELS_SEED_VERSION, models: DEFAULT_MODELS, deletedSeedIds: [] };
	saveJson(FILE, store);
} else {
	if (!store.deletedSeedIds) store.deletedSeedIds = [];
	const tomb = new Set(store.deletedSeedIds);
	let changed = false;

	// ① 退役清理：每次启动强制删除 RETIRED_IDS（不依赖 seedVersion，避免历史竞态导致残留卡死）
	const before = store.models.length;
	store.models = store.models.filter((m) => !RETIRED.has(m.id));
	if (store.models.length !== before) changed = true;

	// ② 一次性刷新：seedVersion 落后时，用最新 DEFAULT 覆盖保留内置模型的定义字段（清空遗留 baseUrl/apiKey 等）
	if ((store.seedVersion ?? 0) < MODELS_SEED_VERSION) {
		for (const d of DEFAULT_MODELS) {
			const m = store.models.find((x) => x.id === d.id);
			if (m) {
				for (const k of MODEL_REFRESH_FIELDS) (m as any)[k] = (d as any)[k];
				m.updatedAt = new Date().toISOString();
			}
		}
		store.seedVersion = MODELS_SEED_VERSION;
		changed = true;
	}

	// ③ 补种缺失的内置模型（跳过墓碑与退役项）；不覆盖管理端已有改动
	for (const d of DEFAULT_MODELS) {
		if (tomb.has(d.id) || RETIRED.has(d.id)) continue;
		if (!store.models.some((m) => m.id === d.id)) {
			store.models.push(d);
			changed = true;
		}
	}

	// ④b 定向迁移（第140轮）：Dimensio dm 系存量模型补 refVideoSecondsWeight=1（参考视频按秒计费·
	//    与出片同价，用户定）。只补缺（undefined 才写）——之后管理端改成 0/0.5 等不会被重复覆盖（版本号幂等）。
	if ((store.refVideoBillVersion ?? 0) < 1) {
		for (const id of ["dm933-sd2.0", "dm933-sd2.0-fast", "dm933-sd2.0-mini"]) {
			const m = store.models.find((x) => x.id === id);
			if (m && m.refVideoSecondsWeight === undefined) {
				m.refVideoSecondsWeight = 1;
				m.updatedAt = new Date().toISOString();
			}
		}
		store.refVideoBillVersion = 1;
		changed = true;
	}

	// ④c 定向迁移（第187轮）：os933-sd2.5 时长上限 15→30（上游 sd-2-5 支持 30s，用户实锤——旧上限会把
	//    前端 30s 请求在翻译器夹成 15s、而按秒计费仍按 30 扣=多扣钱）。只动 duration 参数的 max；
	//    兜底价（无 duration 时的「默认按最高」）仅当仍为旧种子值（45/路由 30）才改成 90/60，防冲掉管理端改价。
	if ((store.osSd25DurVersion ?? 0) < 1) {
		const m = store.models.find((x) => x.id === "os933-sd2.5");
		const f = m?.params?.find((p) => p.key === "duration");
		if (m && f) {
			f.max = 30;
			if (m.cost === 45) m.cost = 90;
			const r480 = m.routes?.find((r) => r.when?.resolution === "480p");
			if (r480 && r480.cost === 30) r480.cost = 60;
			m.updatedAt = new Date().toISOString();
		}
		store.osSd25DurVersion = 1;
		changed = true;
	}

	// ④ 定向迁移（第122轮）：存量库的视频超分 resolution 收敛为 720p-only。
	//    不走 seed bump 整模型刷新（会连带冲掉管理端改过的价格等其它字段），只替换这一个参数字段；
	//    persist 会 bump catalog version → 客户端下拉热更收敛。管理端后续加档不会被本迁移再次收回（版本号幂等）。
	if ((store.volcResVersion ?? 0) < 1) {
		for (const id of ["volc-enhance-generative", "volc-enhance-fast", "volc-enhance-standard", "volc-enhance-professional"]) {
			const m = store.models.find((x) => x.id === id);
			const f = m?.params?.find((p) => p.key === "resolution");
			if (m && f) {
				f.options = ["720p"];
				f.default = "720p";
				m.updatedAt = new Date().toISOString();
			}
		}
		store.volcResVersion = 1;
		changed = true;
	}

	// ⑤ 定向迁移（第130轮）：给存量 seedance 视频生成模型补 modeId="qiji"（只动该字段，不整模型刷新，
	//    不冲掉管理端改过的价格等）。仅当模型无 modeId 时写入（管理端后续改模式不会被本迁移收回）。
	if ((store.modeInitVersion ?? 0) < 1) {
		for (const id of ["seedance-2.0", "seedance-2.0-fast"]) {
			const m = store.models.find((x) => x.id === id);
			if (m && !m.modeId) {
				m.modeId = "qiji";
				m.updatedAt = new Date().toISOString();
			}
		}
		store.modeInitVersion = 1;
		changed = true;
	}
	// ⑤b 定向迁移 v2（第131轮）：**所有**无模式的视频生成模型（capability="video"，如自建的喵-seedance）
	//    补 modeId="qiji"——用户定「无模式的视频模型就是 Qiji 模式」，否则客户端下拉出现「默认」兜底源与
	//    「Qiji 视频」并排像重复项。火山处理类（video-enhance/video-erase 能力）不涉及；只补缺不覆盖。
	if ((store.modeInitVersion ?? 0) < 2) {
		for (const m of store.models) {
			if (m.capability === "video" && !m.modeId) {
				m.modeId = "qiji";
				m.updatedAt = new Date().toISOString();
			}
		}
		store.modeInitVersion = 2;
		changed = true;
	}
	// ⑤c 定向迁移 v3（第131轮）：**所有**无模式的出图模型（capability="image"，含自建）归入「Qiji 图片」
	//    ——与视频同理（用户定）。hidden 内部计费模型（如 fee-thirdparty）绝不归模式（模式关会误伤
	//    其手续费扣费，同第121轮「hidden 不可禁」规则）；图像超分（image-enhance 能力）不涉及；只补缺不覆盖。
	if ((store.modeInitVersion ?? 0) < 3) {
		for (const m of store.models) {
			if (m.capability === "image" && !m.modeId && !m.hidden) {
				m.modeId = "qiji-img";
				m.updatedAt = new Date().toISOString();
			}
		}
		store.modeInitVersion = 3;
		changed = true;
	}
	// ⑤d 定向迁移（第148轮）：星辰全面换线 48/50/51（用户定「接入 48/50/51，其他模型删除」）。
	//    ①旧线 10 模型整删进墓碑（39 线已被上游下架致 xc933 4k 档失效，其余线路能力过时）；
	//    ②保留改造的 4 个用新种子定义**整体覆盖**（含 routes/params/methods/matLimits/计费——「全面更新」语义，
	//      管理端旧改动一并覆盖；⚠ 与「只补缺」迁移不同，勿仿此模式做常规迁移）并 enabled=true 上架
	//      （存量 14 个全被管理端禁用=旧线过时下架，换新线即重新上架，运营可再关）；
	//    ③新增 2 个（xc933-sd2.0-c / xc900-sd2.0-fast-c）由上方补种机制自动入库。版本号幂等，跑一次不再动。
	if ((store.xcRefreshVersion ?? 0) < 1) {
		const dropIds = [
			"xc933-sd2.0-2", "xc933-sd2.0-fast-2", "xc933-sd2.0-b", "xc933-sd2.0-fast-b", "xc933-sd2.0-fast-c",
			"xc900-sd2.0", "xc431-sd2.0", "xc431-sd2.0-fast", "xc700-grok1.5", "xc600-gemini-flash",
		];
		store.models = store.models.filter((m) => !dropIds.includes(m.id));
		for (const id of dropIds) if (!store.deletedSeedIds!.includes(id)) store.deletedSeedIds!.push(id);
		for (const id of ["xc933-sd2.0", "xc933-sd2.0-fast", "xc700-grok1.0", "xc100-grok1.5"]) {
			const d = DEFAULT_MODELS.find((x) => x.id === id);
			const m = store.models.find((x) => x.id === id);
			if (d && m) {
				for (const k of MODEL_REFRESH_FIELDS) (m as any)[k] = (d as any)[k];
				m.matLimits = d.matLimits;
				m.enabled = true;
				m.updatedAt = new Date().toISOString();
			}
		}
		store.xcRefreshVersion = 1;
		changed = true;
	}
	// ⑤e 定向迁移（第149轮）：苏打水按 2026-07-22 上游 /v1/models 清单更新（用户定「全部接入」新线、图片暂不接）。
	//    ①上游已下架的 6 个死链模型（my 整线/hn-900/mo-b/mo-c）整删进墓碑；②存活 10 个**不刷字段**（上游 id
	//    未变、无能力变化证据，保留管理端改动）——只 enabled=true 上架（与新模型一起换新清单上架，运营可再关）
	//    + **只补缺** matLimits（undefined 才写，第131轮接入早于 matLimits 特性）；③新 16 个由补种机制自动入库。
	if ((store.sdsRefreshVersion ?? 0) < 1) {
		const dropIds = ["jm431-sd2.0-2", "jm431-sd2.0-fast-2", "jm431-sd2.0-ds-fast", "jm900-sd2.0", "jm933-sd2.0-b", "jm933-sd2.0-c"];
		store.models = store.models.filter((m) => !dropIds.includes(m.id));
		for (const id of dropIds) if (!store.deletedSeedIds!.includes(id)) store.deletedSeedIds!.push(id);
		for (const m of store.models) {
			if (m.protocol !== "sudashui-video") continue;
			m.enabled = true;
			if (m.matLimits === undefined) {
				const d = DEFAULT_MODELS.find((x) => x.id === m.id);
				if (d?.matLimits) m.matLimits = d.matLimits;
			}
			m.updatedAt = new Date().toISOString();
		}
		store.sdsRefreshVersion = 1;
		changed = true;
	}
	// ⑤f 定向迁移（第156轮）：苏打水收编 26→7 并三模式合一为「简梦S」（用户定「删除舍弃的19款、集合成
	//    简梦S、删除简梦GF/431/933」）。①19 款整删进墓碑（需要时管理端重建同 id 即可再加——请求体全渠道
	//    同构，改 upstreamModel 即换线）；②其余挂 jmgf/jm431/jm933 的模型（含管理端自建）全部归入 jms——
	//    三个旧模式随后由 modes.ts v12 迁移删除（modes.ts import 本文件，本迁移先跑有保证）。版本号幂等。
	if ((store.sdsConsolidateVersion ?? 0) < 1) {
		const dropIds = [
			"gf2-sd2.0", "gf2-sd2.0-fast", "gf2-sd2.0-mini",
			"jm431-sd2.0-pd", "jm431-sd2.0-pd-fast",
			"jm933-sd2.0", "jm933-sd2.0-fast", "jm933-sd2.0-real", "jm933-sd2.0-fast-real",
			"jm933-sd2.0-d", "jm933-sd2.0-dj-fast", "jm933-sd2.0-e", "jm933-sd2.0-e2",
			"jm933-sd2.0-xh-fast", "jm933-sd2.0-pd", "jm933-sd2.0-pd-fast",
			"xinghe-2.0", "xinghe-fast", "xinghe-mini",
		];
		store.models = store.models.filter((m) => !dropIds.includes(m.id));
		for (const id of dropIds) if (!store.deletedSeedIds!.includes(id)) store.deletedSeedIds!.push(id);
		for (const m of store.models) {
			if (["jmgf", "jm431", "jm933"].includes(m.modeId ?? "")) {
				m.modeId = "jms";
				m.updatedAt = new Date().toISOString();
			}
		}
		store.sdsConsolidateVersion = 1;
		changed = true;
	}
	// ⑤g 定向迁移（第159轮）：简梦P 按 2026-07 版文档「Supported Models」清单收敛（用户定「没有了就删掉」）。
	//    veo31（清单已除名、仅存能力矩阵）/ veo31-ref（文档整体消失）整删进墓碑——上游若恢复，管理端重建
	//    同 id 模型即可（veo31 翻译器 CAPS 守卫仍在；veo31-ref 无守卫直发、上游自校验）。版本号幂等。
	if ((store.jmpTrimVersion ?? 0) < 1) {
		const dropIds = ["veo31", "veo31-ref"];
		store.models = store.models.filter((m) => !dropIds.includes(m.id));
		for (const id of dropIds) if (!store.deletedSeedIds!.includes(id)) store.deletedSeedIds!.push(id);
		store.jmpTrimVersion = 1;
		changed = true;
	}
	// ⑤h 定向迁移（第162轮）：星辰 50 线 fast 素材能力放宽 图9视0音0→图9视3音3（2026-07-26 config）——
	//    命名按素材量惯例改名（用户定）：旧 xc900-sd2.0-fast-c 整删进墓碑（管理端改过价的照删=改名语义）。
	//    ⚠ 新 id xc933-sd2.0-fast-c 与第148轮 ⑤d 删除的旧 37 线模型**撞名**（生产库墓碑仍在、③ 补种会被
	//    挡住）→ 此处先出墓碑再**定向补种**（不能只靠 ③——③ 在本段之前跑；且全新库二启时 ⑤d 也在本段
	//    之前把它再删进墓碑——恒在此兜底补回，保证任何库形态一次启动收敛）。53 线 -mj 双模型与图片线
	//    4 模型无撞名、照走 ③ 补种。版本号幂等。
	if ((store.xc50RenameVersion ?? 0) < 1) {
		store.models = store.models.filter((m) => m.id !== "xc900-sd2.0-fast-c");
		if (!store.deletedSeedIds!.includes("xc900-sd2.0-fast-c")) store.deletedSeedIds!.push("xc900-sd2.0-fast-c");
		store.deletedSeedIds = store.deletedSeedIds!.filter((id) => id !== "xc933-sd2.0-fast-c");
		const fcSeed = DEFAULT_MODELS.find((x) => x.id === "xc933-sd2.0-fast-c");
		if (fcSeed && !store.models.some((m) => m.id === "xc933-sd2.0-fast-c")) store.models.push(fcSeed);
		store.xc50RenameVersion = 1;
		changed = true;
	}
	// ⑤j 定向迁移（第216轮）：星辰按 2026-08-09 实时 config 对齐**存量**模型能力（新模型走 ③ 补种）。
	//    ⚠ 全部守卫式——仅当字段仍为旧种子形状才改（管理端改过的分毫不动）；价格/enabled 一概不碰：
	//    ① xc700-grok1.0：时长 6/10 两档 → 连续 1-15s；比例 5 档 → 7 档（51 线能力大改）；
	//    ② xc100-grok1.5：图上限 1 → 7（matLimits+params 无关）；时长下限 4 → 5；比例 3 档 → 16:9/9:16；
	//    ③ xc933-sd2.0-fast（48 线）：methods 去 frames（config 已无 frames2video——留着会让用户选首尾帧后
	//      被翻译器明确拒绝）；④ 48 线双模型比例 3/8 档 → 6 档；⑤ 50 线 sd2.0 时长下限 5 → 4、双模型比例 → 5 档。
	if ((store.xcCaps216Version ?? 0) < 1) {
		const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
		const touch = (m: ModelDef): void => { m.updatedAt = new Date().toISOString(); };
		const setAspects = (id: string, oldOpts: string[], next: string[]): void => {
			const m = store.models.find((x) => x.id === id);
			const f = m?.params?.find((p) => p.key === "aspect_ratio");
			if (m && f && eq(f.options, oldOpts)) { f.options = [...next]; touch(m); }
		};
		const g10 = store.models.find((x) => x.id === "xc700-grok1.0");
		{
			const f = g10?.params?.find((p) => p.key === "duration");
			if (g10 && f && f.type === "enum" && eq(f.options, ["6", "10"])) {
				g10.params = g10.params!.map((p) => p.key === "duration"
					? { key: "duration", label: "时长", type: "number", default: 15, min: 1, max: 15, step: 1, unit: "s" } as ParamField
					: p);
				touch(g10);
			}
		}
		setAspects("xc700-grok1.0", ["16:9", "9:16", "1:1", "2:3", "3:2"], AIS_GROK_ASPECTS);
		const g15 = store.models.find((x) => x.id === "xc100-grok1.5");
		if (g15) {
			if (g15.matLimits?.img === 1) { g15.matLimits = { ...g15.matLimits, img: 7 }; touch(g15); }
			const f = g15.params?.find((p) => p.key === "duration");
			if (f && f.type === "number" && f.min === 4) { f.min = 5; touch(g15); }
		}
		setAspects("xc100-grok1.5", ["16:9", "9:16", "1:1"], AIS_HV);
		const f48 = store.models.find((x) => x.id === "xc933-sd2.0-fast");
		if (f48 && eq(f48.methods, ["omni", "frames"])) { f48.methods = undefined; touch(f48); }
		setAspects("xc933-sd2.0", ["16:9", "9:16", "1:1"], AIS_ASPECTS_6);
		setAspects("xc933-sd2.0-fast", ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "2:3", "3:2"], AIS_ASPECTS_6);
		const c50 = store.models.find((x) => x.id === "xc933-sd2.0-c");
		{
			const f = c50?.params?.find((p) => p.key === "duration");
			if (c50 && f && f.type === "number" && f.min === 5) { f.min = 4; touch(c50); }
		}
		setAspects("xc933-sd2.0-c", ["16:9", "9:16", "1:1"], AIS_ASPECTS_5);
		setAspects("xc933-sd2.0-fast-c", ["16:9", "9:16", "1:1"], AIS_ASPECTS_5);
		store.xcCaps216Version = 1;
		changed = true;
	}
	// ⑤k 定向迁移（第242轮）：简梦P 按 2026-08 新版文档（api.pixellelabs.com）收敛。
	//    v1：Sora 系 4 款整删进墓碑（该渠道第159轮用户定式「（文档里）没有了就删掉」）；新 H3video-2k 走
	//    ③ 补种（与全部历史墓碑无撞名，已核对）。⚠ 同轮补充用户令**恢复 gemini-omni-flash/veo31-fast**——
	//    首版 v1 曾把这两款一并删除，dropIds 已收窄为 4（未跑过首版的库这两款原样保留、管理端真价不动）；
	//    v2 兜底：对已跑过首版 v1 的库（如本机 dev）出墓碑+定向补种（⑤h 同款——③ 在本段之前跑，
	//    只能在此补）。版本号幂等。
	if ((store.jmpH3Version ?? 0) < 1) {
		const dropIds = ["sora2", "sora-v3-pro", "sora-v3-pro-1080p", "sora-v3-fast"];
		store.models = store.models.filter((m) => !dropIds.includes(m.id));
		for (const id of dropIds) if (!store.deletedSeedIds!.includes(id)) store.deletedSeedIds!.push(id);
		store.jmpH3Version = 1;
		changed = true;
	}
	if ((store.jmpH3Version ?? 0) < 2) {
		for (const id of ["gemini-omni-flash", "veo31-fast"]) {
			store.deletedSeedIds = store.deletedSeedIds!.filter((x) => x !== id);
			const seed = DEFAULT_MODELS.find((x) => x.id === id);
			if (seed && !store.models.some((m) => m.id === id)) store.models.push(seed);
		}
		store.jmpH3Version = 2;
		changed = true;
	}
	// ⑤i 定向迁移（第163轮）：全部存量模型按 classifyFamily 补 familyId（含管理端自建——名/上游名带特征词
	//    即归入；只补缺不覆盖，管理端之后改家族/清空不会被重复收回；纯展示分组，零门禁/计费影响）。
	if ((store.familyInitVersion ?? 0) < 1) {
		for (const m of store.models) {
			if (m.familyId === undefined) {
				const fid = classifyFamily(m);
				if (fid) {
					m.familyId = fid;
					m.updatedAt = new Date().toISOString();
				}
			}
		}
		store.familyInitVersion = 1;
		changed = true;
	}
	if (changed) persist();
}

/** 是否有模型引用该模式（modes.ts 迁移清理旧占位模式时用） */
export function anyModelInMode(modeId: string): boolean {
	return store.models.some((m) => m.modeId === modeId);
}

/** 是否有模型引用该家族（管理端展示计数等辅助用） */
export function anyModelInFamily(familyId: string): boolean {
	return store.models.some((m) => m.familyId === familyId);
}

/** 删除家族时清空引用它的模型 familyId（客户端回落「其他」分组）。供 families.ts deleteFamily 调用。 */
export function clearFamilyFromModels(familyId: string): void {
	let changed = false;
	for (const m of store.models) {
		if (m.familyId === familyId) {
			m.familyId = undefined;
			m.updatedAt = new Date().toISOString();
			changed = true;
		}
	}
	if (changed) persist();
}

/** 删除模式时清空引用它的模型 modeId（回落默认模式常开）。供 modes.ts deleteMode 调用。 */
export function clearModeFromModels(modeId: string): void {
	let changed = false;
	for (const m of store.models) {
		if (m.modeId === modeId) {
			m.modeId = undefined;
			m.updatedAt = new Date().toISOString();
			changed = true;
		}
	}
	if (changed) persist();
}

function persist(bump = true): void {
	if (bump) store.version += 1;
	saveJson(FILE, store);
}

export function catalogVersion(): string {
	return `v${store.version}`;
}

export function listModels(): ModelDef[] {
	return store.models;
}

/** 全表补齐 order（首次排序时把 未设 的按当前显示序压实成 1..n，之后只做槽位置换） */
function ensureModelOrders(): void {
	const sorted = [...store.models].sort((a, b) =>
		(a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER)
		|| store.models.indexOf(a) - store.models.indexOf(b));
	sorted.forEach((m, i) => { m.order = i + 1; });
}

/**
 * 按 ids 给出的新顺序重排这批模型（第176轮，管理端同组内拖动）。
 * ⚠ 语义（勿改成 reorderModes 那种整表重排）：只把**这批模型自己的 order 槽位**按新顺序重新分配，
 * 其余模型的 order 数值一律不动——管理端是「按渠道/模式/家族分组 + 状态/范围筛选」的视图，
 * 整表重排会把被筛掉的模型甩到末尾、破坏它们的相对次序。
 */
export function reorderModels(ids: string[]): boolean {
	const listed = ids.map((id) => store.models.find((m) => m.id === id)).filter((m): m is ModelDef => !!m);
	if (listed.length < 2) return false;
	ensureModelOrders();
	const slots = listed.map((m) => m.order!).sort((a, b) => a - b);
	const at = new Date().toISOString();
	listed.forEach((m, i) => { m.order = slots[i]; m.updatedAt = at; });
	persist(); // bump 目录版本 → 客户端 ≤30s 热更下拉顺序
	return true;
}

export function listEnabledModels(): ModelDef[] {
	return store.models.filter((m) => m.enabled);
}

export function getModelDef(id: string): ModelDef | undefined {
	return store.models.find((m) => m.id === id);
}

/**
 * 某模型对某用户归属（受众）是否开放（第110轮）：受众 = 渠道商 id 或 源站（agentId 空）。
 * all/未设=全开（存量行为不变）；select=在 shareAgentIds 内；none=对谁都不开放。
 * catalog 下发过滤与 /v1/generate 调用校验共用这一把尺（hidden 与此维度独立——hidden 只控下发不控调用）。
 * 第124轮渠道商层级：select 按**归属链**判——链上任一受众（直属商或其任一上级商）被授权即开放
 * （源站开放给某商 = 该商整个下游体系可用；要收窄用商级 blockedModels 禁用清单，任一级禁即禁）。
 */
export function modelVisibleToAgent(m: ModelDef, agentId?: string): boolean {
	const scope = m.shareScope ?? "all";
	if (scope === "all") return true;
	if (scope === "select") {
		const share = m.shareAgentIds ?? []; // 旧：按具体受众清单（存量数据仍生效；新 UI 保存时清空）
		const shareGroups = m.shareGroupIds ?? []; // 第167轮：按渠道商分组（受众的生效分组命中即开放）
		return audienceChain(agentId).some(
			(aud) => share.includes(aud) || (shareGroups.length > 0 && shareGroups.includes(audienceGroupId(aud))),
		);
	}
	return false; // none
}

/** 仅 bump 目录版本（第167轮）：分组归属/源站分组变化会改变模型开放范围，但不动 models 数据——
 *  调用方（分组管理路由）用它让**全部用户**的 catalog version 变化、客户端 ≤30s 热更。 */
export function touchModelsVersion(): void {
	persist();
}

/**
 * 某模型对某用户归属是否**可用**（第121轮）= 模型侧开放范围（shareScope）且 不在其渠道商的
 * 禁用清单（Agent.blockedModels）——双闸任一不过即不可用。catalog 下发 / generate+batch 校验 /
 * 门户模型定价 统一走这一把尺（modelVisibleToAgent 仅供受众开放维度单独展示时用）。
 * hidden 内部计费模型（fee-thirdparty 手续费）不受商级禁用影响——禁了会打断其用户的手续费扣费。
 */
export function modelAllowedForAgent(m: ModelDef, agentId?: string): boolean {
	if (!modelVisibleToAgent(m, agentId)) return false;
	if (m.hidden) return true;
	return !agentModelBlocked(agentId, m.id);
}

export function createModel(input: Partial<ModelDef> & Pick<ModelDef, "id" | "label" | "capability" | "protocol">): ModelDef {
	const now = new Date().toISOString();
	const m: ModelDef = {
		id: input.id.trim(),
		label: input.label,
		capability: input.capability,
		protocol: input.protocol,
		channelId: input.channelId || undefined,
		upstreamModel: input.upstreamModel || undefined,
		routes: input.routes && input.routes.length ? input.routes : undefined,
		baseUrl: input.baseUrl || undefined,
		apiKey: input.apiKey || undefined,
		params: input.params ?? [],
		cost: input.cost ?? 10,
		costField: input.costField?.trim() || undefined,
		costPerUnit: input.costPerUnit != null ? Number(input.costPerUnit) : undefined,
		hidden: input.hidden || undefined,
		shareScope: input.shareScope || undefined,
		shareAgentIds: input.shareAgentIds && input.shareAgentIds.length ? input.shareAgentIds : undefined,
		shareGroupIds: input.shareGroupIds && input.shareGroupIds.length ? input.shareGroupIds : undefined,
		// hidden 内部计费模型（fee-thirdparty=LibTV/即梦手续费，走用户自己账号+按次收费）与模式体系无关，
		// 绝不持有 modeId（归了模式=被禁该模式的用户手续费扣费被 403 打断；用户定，勿回退）
		modeId: input.hidden ? undefined : (input.modeId || undefined),
		// 家族（第163轮）：显式给值用给的（""=不归家族）；字段缺席=按名自动归类（新渠道接入 xx933-sd2.0
		// 之类命名直接落对家族，零手配）。hidden 不归家族。
		familyId: input.hidden
			? undefined
			: input.familyId !== undefined
				? (input.familyId || undefined)
				: classifyFamily({ id: input.id.trim(), label: input.label, capability: input.capability, upstreamModel: input.upstreamModel || undefined, hidden: input.hidden }),
		methods: input.methods && input.methods.length ? input.methods : undefined,
		officialAssets: input.officialAssets || undefined,
		refVideoSecondsWeight: input.refVideoSecondsWeight != null && Number(input.refVideoSecondsWeight) > 0 ? Number(input.refVideoSecondsWeight) : undefined,
		matLimits: normMatLimits(input.matLimits),
		note: normModelNote(input.note),
		enabled: input.enabled ?? true,
		createdAt: now,
		updatedAt: now,
	};
	const idx = store.models.findIndex((x) => x.id === m.id);
	if (idx >= 0) store.models[idx] = m;
	else store.models.push(m);
	persist();
	return m;
}

export function updateModel(id: string, patch: Partial<Omit<ModelDef, "id" | "createdAt">>): ModelDef | undefined {
	const m = getModelDef(id);
	if (!m) return undefined;
	Object.assign(m, patch, { updatedAt: new Date().toISOString() });
	// hidden 内部计费模型与模式体系无关（见 createModel 注释）：任何路径写入的 modeId 一律剥除
	if (m.hidden) m.modeId = undefined;
	// 家族归一（第163轮）：空串=清空（客户端归「其他」）；hidden 不归家族
	if ("familyId" in patch) m.familyId = (m.familyId as string) || undefined;
	if (m.hidden) m.familyId = undefined;
	// 素材上限清洗（第145轮）：null/空对象/非法值统一收敛为 undefined=不限（管理端清空即恢复不限）
	if ("matLimits" in patch) m.matLimits = normMatLimits(m.matLimits);
	// 备注清洗（第166轮）：trim + 截断；空/null=清除（客户端回落默认「参考素材上限」文案）
	if ("note" in patch) m.note = normModelNote(m.note);
	// 开放范围清单归一（第167轮）：空数组=未设（undefined），两清单同尺
	if ("shareAgentIds" in patch) m.shareAgentIds = m.shareAgentIds?.length ? m.shareAgentIds : undefined;
	if ("shareGroupIds" in patch) m.shareGroupIds = m.shareGroupIds?.length ? m.shareGroupIds : undefined;
	persist();
	return m;
}

/** 模型备注清洗（第166轮）：trim + 截 200 字；空/非字符串=undefined（=未设，客户端显示 matLimits 派生默认文案） */
function normModelNote(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim();
	return t ? t.slice(0, 200) : undefined;
}

/** 命中的重定向规则：when 中每个键值都与请求参数（字符串比较）相等；无规则/不命中返回 undefined */
export function matchRoute(m: ModelDef, params?: Record<string, unknown>): ModelRoute | undefined {
	const p = params ?? {};
	for (const r of m.routes ?? []) {
		const cond = r.when ?? {};
		if (Object.keys(cond).every((k) => String(p[k]) === String(cond[k]))) return r;
	}
	return undefined;
}

/**
 * 实际计费：
 *  ① 按字段计费（配了 costField，如视频 duration）：本次扣费 = 每单位价 × 字段值（四舍五入）。
 *  ② 否则按固定价。两条路的取值优先级一致：
 *     渠道商按档价（override.rules 命中）> 渠道商默认价（override.cost/costPerUnit，设了即拉平平台档位差价）
 *     > 平台命中路由（ModelRoute）> 平台模型基准。
 * override = 渠道商定价覆盖（agentModelPricing，仅名下用户生效）。
 * ⚠ 语义须与客户端预估（src/lib/genParams.ts estimateCost）及 catalog 下发（buildCatalog 逐档投影）一致。
 */
export function resolveModelCost(
	m: ModelDef,
	params?: Record<string, unknown>,
	override?: { cost?: number; costPerUnit?: number; rules?: { when: Record<string, string>; cost?: number; costPerUnit?: number }[] },
): number {
	const p = params ?? {};
	const route = matchRoute(m, params);
	const ovRule = override?.rules?.find((r) => Object.keys(r.when ?? {}).every((k) => String(p[k]) === String(r.when[k])));
	if (m.costField) {
		const perUnit = ovRule?.costPerUnit ?? override?.costPerUnit ?? route?.costPerUnit ?? m.costPerUnit ?? 0;
		const unit = Math.max(0, Number(p[m.costField]) || 0);
		if (perUnit > 0 && unit > 0) return Math.round(perUnit * unit);
	}
	return ovRule?.cost ?? override?.cost ?? route?.cost ?? m.cost;
}

export function deleteModel(id: string): boolean {
	const before = store.models.length;
	store.models = store.models.filter((m) => m.id !== id);
	if (store.models.length !== before) {
		// 内置模型记墓碑，重启后不再补种（使删除可持久）
		if (BUILTIN_IDS.has(id)) {
			if (!store.deletedSeedIds) store.deletedSeedIds = [];
			if (!store.deletedSeedIds.includes(id)) store.deletedSeedIds.push(id);
		}
		persist();
		return true;
	}
	return false;
}
