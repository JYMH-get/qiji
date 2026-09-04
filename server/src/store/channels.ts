/**
 * 渠道（上游凭据组）存储（文件持久化）。
 *
 * 一个渠道 = 一组上游凭据 { baseUrl + apiKey }。多个模型可归属同一渠道，
 * 共用其地址与密钥（"同渠道密钥和 url 一样"）。模型仍各自持有 protocol / 上游模型名 / 重定向规则。
 *
 * 设计要点：
 *  - 渠道不绑定 protocol——聚合网关（如 g-aisc）一把 key 同时兼容 OpenAI/Anthropic/Gemini，
 *    所以协议是模型级属性，渠道只提供凭据。
 *  - 模型 channelId 指向渠道；模型自身 baseUrl/apiKey 若填写则覆盖渠道（精细控制）。
 */
import { loadJson, saveJson, genId } from "./db.ts";

export interface ChannelDef {
	id: string;
	/** 渠道名（如「g-aisc 聚合网关」「简梦」） */
	name: string;
	/** 上游地址（结尾斜杠自动去除） */
	baseUrl: string;
	/** 上游密钥（管理端列表脱敏） */
	apiKey: string;
	enabled: boolean;
	note?: string;
	/** 排序（第165轮：管理端卡片拖动重排；仅影响管理端显示顺序——客户端不感知渠道）。缺省=按加入顺序排后 */
	order?: number;
	createdAt: string;
	updatedAt: string;
}

interface Store {
	channels: ChannelDef[];
	/** 管理端删除的内置渠道墓碑：阻止缺失补种在重启时把已删除渠道复活。 */
	deletedSeedIds?: string[];
}

const FILE = "channels.json";

/** 内置渠道 id（模型按此归属；apiKey 留空 → 走环境 GATEWAY_API_KEY / JIANMENG_API_KEY） */
export const CH_GAISC = "ch-gaisc";
export const CH_JIANMENG = "ch-jianmeng";
export const CH_VOLC = "ch-volc-mediakit";
export const CH_SUDASHUI = "ch-sudashui";
export const CH_AISTARS = "ch-aistars";
export const CH_HUAYING = "ch-huaying";
export const CH_DIMENSIO = "ch-dimensio";
export const CH_AIVIDE = "ch-aivide";
export const CH_JIANMENGP = "ch-jianmengp";
export const CH_MUSEM = "ch-musem";
export const CH_JMZ = "ch-jmz";
export const CH_JMH = "ch-jmh";
export const CH_YUNWU = "ch-yunwu";
export const CH_JMT = "ch-jmt";
export const CH_JMF = "ch-jmf";
export const CH_OVERSEAS = "ch-overseas";
export const CH_SUANLI = "ch-suanli";
export const CH_SKYLEE = "ch-skylee";
export const CH_CONGGE = "ch-congge";
export const CH_AUTODL = "ch-autodl";
export const CH_QIJICLOUD = "ch-qijicloud";
export const CH_BYS = "ch-bys";
export const CH_QIQI = "ch-qiqi";
export const CH_OFFICIAL = "ch-official";
// Yali（api.yaliai.com，第229轮）：⚠ 一把 Key 绑定一种「接口类型」→ 按接口类型分两个渠道，各填各的 Key
export const CH_YALI_OPENAI = "ch-yali-openai";
export const CH_YALI_GEMINI = "ch-yali-gemini";

const DEFAULT_CHANNELS: ChannelDef[] = [
	{
		id: CH_GAISC, name: "G-AISC", baseUrl: "https://sub.g-aisc.com", apiKey: "",
		enabled: true, note: "聚合网关；密钥用环境 GATEWAY_API_KEY（渠道留空即沿用）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_JIANMENG, name: "简梦 Seedance", baseUrl: "https://api.jian1.vip", apiKey: "",
		enabled: true, note: "简梦视频；密钥用环境 JIANMENG_API_KEY（渠道留空即沿用）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_VOLC, name: "火山引擎 MediaKit", baseUrl: "https://mediakit.cn-beijing.volces.com", apiKey: "",
		enabled: true, note: "视频超分/去字幕（智能处理）；密钥填火山 AI MediaKit 控制台 API Key（留空走环境 VOLC_API_KEY）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_SUDASHUI, name: "苏打水（简梦）", baseUrl: "https://api.sudashuiapi.com", apiKey: "",
		enabled: true, note: "简梦S 模式（苏打水 7 模型，第156轮收编）视频渠道；素材上传固定走 files.sudashuiapi.com；密钥填苏打水 sk-（留空走环境 SUDASHUI_API_KEY）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_AISTARS, name: "星辰（AIStartLab）", baseUrl: "https://api.video.aistarslab.com/openapi", apiKey: "",
		enabled: true, note: "星辰模式（xc 系 14 模型）视频渠道；统一生成协议；密钥填 AIStartLab sk_（留空走环境 AISTARS_API_KEY）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_HUAYING, name: "画影（AI-Studio）", baseUrl: "https://ai-studio.aixyzz.com/v1", apiKey: "",
		enabled: true, note: "画影模式（hy 系 6 模型）视频渠道；密钥填 API 控制台的 lv_ 密钥（留空走环境 HUAYING_API_KEY）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_DIMENSIO, name: "Dimensio", baseUrl: "https://jimeng.dimensio.cn", apiKey: "",
		enabled: true, note: "Dimensio 模式（dm 系 3 模型）视频渠道；密钥填用户控制台的 pk_ API Key（留空走环境 DIMENSIO_API_KEY）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_AIVIDE, name: "Aivide", baseUrl: "https://aivideo.beauty", apiKey: "",
		enabled: true, note: "Aivide 模式（av933-2.0）视频渠道；密钥填平台 sk- API 令牌（留空走环境 AIVIDE_API_KEY）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_JIANMENGP, name: "简梦P", baseUrl: "", apiKey: "",
		enabled: true, note: "简梦P 模式（Sora/Gemini/Veo 系 6 模型）视频渠道；⚠ 上游文档未给地址——部署后此处填 API Base URL 与 sk- 密钥（留空走环境 JIANMENGP_BASE_URL / JIANMENGP_API_KEY）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_MUSEM, name: "简梦M（MuseAI）", baseUrl: "https://museai.vip", apiKey: "",
		enabled: true, note: "简梦M 模式（jmm 系 4 模型）视频渠道；密钥填 MUSE- 开头的 API Key（留空走环境 MUSEM_API_KEY）；鉴权走 apikey 请求头",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_JMZ, name: "简梦Z（zexitongxue）", baseUrl: "https://zexitongxue.com", apiKey: "",
		enabled: true, note: "简梦Z 模式（jmz 系 视频14+图片7 模型）渠道；密钥填本站 API Key（Bearer 鉴权，留空走环境 JMZ_API_KEY）；⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos、/v1/images/*）；图片 gpt-image-2 的 2K/4K 能力由 Key 分组决定（站方控制台配「image2 4k」分组）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_JMH, name: "简梦H（ZhengAPI）", baseUrl: "https://zhengapi.top", apiKey: "",
		enabled: true, note: "简梦H 模式（jmh 系 图片6+视频9 模型）渠道；密钥填 ZhengAPI 的 sk- Key（Bearer 鉴权，留空走环境 JMH_API_KEY）；Base URL 填根域不带 /v1（翻译器自拼 /v1/images/generations、/v1/chat/completions）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_JMF, name: "简梦F（vosle）", baseUrl: "https://new.vosle.xyz", apiKey: "",
		enabled: true, note: "简梦F 模式（jmf933-sd2.0·Seedance 2.0）视频渠道；密钥填服务方发放的 API Key（Bearer 鉴权，留空走环境 JMF_API_KEY）；⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos）；模型 ID 按 比例/时长 现拼；成片下载须带同一密钥且 24h 时效（完成即转存 OSS）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_JMT, name: "简梦T（chre3）", baseUrl: "https://llm.chre3.com", apiKey: "",
		enabled: true, note: "简梦T 模式（sd2-c8·Seedance 2.0 满血版）视频渠道；密钥填服务方发放的 API Key（Bearer 鉴权，留空走环境 JMT_API_KEY）；⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos）；720p 固定、生成自带声音",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_OVERSEAS, name: "overseas（出海营）", baseUrl: "https://api.aiid.edu.kg", apiKey: "",
		enabled: true, note: "overseas 模式（os 系 5 模型·Seedance 任务格式）视频渠道；密钥填服务方发放的 sk-（Bearer 鉴权，留空走环境 OVERSEAS_API_KEY）；⚠ Base URL 填根域（翻译器自拼 /api/v3/contents/generations/tasks）；素材经 content 数组混排、name 与 @ImageN 图例对应",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_SUANLI, name: "算力（xienlive）", baseUrl: "https://xienlive.com", apiKey: "",
		enabled: true, note: "算力模式（sl933-minimax-h3·MiniMax H3 音视频同步）视频渠道；密钥填服务方发放的 sk-（Bearer 鉴权，留空走环境 SUANLI_API_KEY）；⚠ Base URL 填根域（翻译器自拼 /api/v1/video/generate|generate-flf|query）；素材经 materials 混排数组、提示词 <<<N>>> 0 基下标引用（图例自动转写）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_YALI_OPENAI, name: "Yali · OpenAI Images", baseUrl: "https://api.yaliai.com", apiKey: "",
		enabled: true, note: "Yali 模式图片渠道（yali-gpt-image-2）；⚠ 密钥必须填**接口类型=OpenAI Images**的那把 Key——Yali 一把 Key 只能调它绑定的那类接口，填错返回 403；留空走环境 YALI_API_KEY；Base URL 填根域（翻译器自拼 /v1/images/generations|edits）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_YALI_GEMINI, name: "Yali · Banana/Gemini", baseUrl: "https://api.yaliai.com", apiKey: "",
		enabled: true, note: "Yali 模式图片渠道（yali-gemini 三款）；⚠ 密钥必须填**接口类型=Banana / Gemini**的那把 Key（与 OpenAI Images 那把互不通用，填错返回 403）；无环境兜底——必须在此填；Base URL 同上填根域",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_SKYLEE, name: "Skylee（808relay）", baseUrl: "https://api.808relay.com", apiKey: "",
		enabled: true, note: "Skylee 模式（sky 系 12 图片模型）渠道；密钥填站点 API Key（Bearer 鉴权，留空走环境 SKYLEE_API_KEY）；⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/images/generations?async=true、/v1/images/tasks）；主线异常可临时改 https://api2.808relay.com（Key/模型名/参数不变）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_CONGGE, name: "congge（聪宸）", baseUrl: "https://congchen.top", apiKey: "",
		enabled: true, note: "congge 模式（图片 3 款 + 视频 4 款·Seedance 2.0/2.5）渠道；图片与视频**同一把 Key**（默认分组即可调全部公开模型），密钥填站点 sk-（Bearer 鉴权，留空走环境 CONGGE_API_KEY）；⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/images/generations|edits、/v1/videos）；上游视频模型名带空格且大小写敏感，由 routes 按分辨率重定向，勿手改",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_AUTODL, name: "autodl（autodl.art）", baseUrl: "https://autodl.art", apiKey: "",
		enabled: true, note: "autodl 模式（adl 系 3 模型·ComfyUI 工作流：多图参考/文生/首尾帧）视频渠道；⚠ 密钥填控制台「令牌管理」创建的 Token（分组选 ComfyUI；**原样 Authorization 头、不带 Bearer 前缀**，留空走环境 AUTODL_API_KEY）；⚠ 三个模型的「上游模型名」=各自工作流的 workflow_id——部署后必须逐模型填入真实 ID（种子是占位符，未填提交明确报错）；Base URL 填根域（翻译器自拼 /api/v1/comfyui/comfyui_workflow/*）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_QIJICLOUD, name: "奇迹云（autodl 实例池）", baseUrl: "https://www.autodl.art", apiKey: "",
		enabled: true, note: "奇迹云模式（qj933-minimax-h3·自建 ComfyUI 实例池）视频渠道；⚠ 此处填 autodl **开发者Token**（控制台→设置→开发者Token，原样 Authorization 无 Bearer；与 autodl 模式的 ComfyUI 令牌不是同一把）；实例注册/分组/开关机在管理端「云实例」页；模型的工作流骨架在服务端代码，上游模型名=骨架名（jianyi933）勿改",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_BYS, name: "BYS（Boyesir AI）", baseUrl: "https://www.boyesir.icu", apiKey: "",
		enabled: true, note: "BYS 模式（bys 系 15 视频模型·Seedance 2.0/2.5、MiniMax H3、Kling 3.0 Turbo、Gemini Omni）渠道；密钥填站点 sk-（控制台→令牌创建，Bearer 鉴权，留空走环境 BYS_API_KEY）；⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos/generations、/v1/tasks/{id}）；⚠ 该渠道只有参考图字段（无参考视频/音频、无首尾帧），带视频或音频素材的请求会被前置明确拒；上游名须逐字照抄（站点清单里有带中文的 seedance2.5-10图、带空格的 minimax-h3 768p），种子与 routes 已照抄、勿手改；本站共 69 款模型，种子只精选 15 款，要补款=在此渠道新建模型（协议 bys-video、上游名照抄站点清单）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_QIQI, name: "QiQi（pidoi）", baseUrl: "https://pidoi.com", apiKey: "",
		enabled: true, note: "QiQi 模式视频渠道（2 款：qq933-sd2.0-720p·Seedance 官转 / qq933-sora-v3-pro·933 真人视频）；密钥填站点 sk-（控制台→令牌创建，Bearer 鉴权，留空走环境 QIQI_API_KEY）；⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos、/v1/videos/{id}、/v1/videos/{id}/content）；⚠ **同站两套请求形态**，翻译器按上游模型名分派（seedace-2.0-720p=content[] 多模态、支持首尾帧、不传 resolution；sora-v3-933-pro=扁平 image_url+reference_*、resolution 必填 720p、seconds 仅 15、不支持尾帧、素材总数≤12）——新建模型时上游名照抄站点清单（GET /v1/models 带 Bearer 可自助拉取），**逐字勿改**（seedace 少一个 n 是站方原样写法）；素材上限 9 图 + 3 音频 + 3 视频，⚠ Seedance 款用音频/视频参考时必须至少 1 张图（上游硬约束，已前置拒单）",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_OFFICIAL, name: "官方", baseUrl: "https://kwjm.com", apiKey: "",
		enabled: true, note: "官方模式视频渠道（6 款 dreamina-seedance-2-0 / 2-5 系模型）；密钥填站点 API Key（Bearer 鉴权，留空走环境 OFFICIAL_API_KEY）；Base URL 填根域 https://kwjm.com 不带 /v1，翻译器自拼 /v1/videos/generations；2.0 系上限 9 图+3 视频+3 音频、4~15 秒且不可纯音频，2.5 系上限 30 图+10 视频+10 音频、4~30 秒且允许纯音频；上游模型名逐字照抄文档，价格暂为占位价，上线前须定真价；模型清单可用 GET /v1/models（需 Bearer）更新",
		createdAt: "", updatedAt: "",
	},
	{
		id: CH_YUNWU, name: "云雾（yunwu.ai）", baseUrl: "https://yunwu.ai", apiKey: "",
		enabled: true, note: "云雾模式文本渠道（标准 OpenAI chat 协议，走通用 openai-chat 翻译器）；⚠ 密钥必须在此填（无独立环境变量兜底——留空会错发网关 GATEWAY_API_KEY 给 yunwu.ai 得 401）；Base URL 填根域不带 /v1；加模型=管理端新建（协议 openai-chat、渠道选本条、上游名照抄站内模型名），零代码",
		createdAt: "", updatedAt: "",
	},
];

const BUILTIN_CHANNEL_IDS = new Set(DEFAULT_CHANNELS.map((c) => c.id));

let store: Store = loadJson<Store>(FILE, { channels: [], deletedSeedIds: [] });
{
	// 补种缺失的内置渠道（首启或旧库缺失时），不覆盖已有改动
	const now = new Date().toISOString();
	const tomb = new Set(store.deletedSeedIds ?? []);
	let changed = false;
	for (const d of DEFAULT_CHANNELS) {
		if (tomb.has(d.id)) continue;
		if (!store.channels.some((c) => c.id === d.id)) {
			store.channels.push({ ...d, createdAt: now, updatedAt: now });
			changed = true;
		}
	}
	if (changed) saveJson(FILE, store);
}

function persist(): void {
	saveJson(FILE, store);
}

const strip = (u: string) => u.replace(/\/+$/, "");
const ord = (c: ChannelDef): number => c.order ?? Number.MAX_SAFE_INTEGER; // 未设 order=按加入顺序排后（稳定排序保插入序）

export function listChannels(): ChannelDef[] {
	return [...store.channels].sort((a, b) => ord(a) - ord(b));
}

export function getChannel(id: string): ChannelDef | undefined {
	return store.channels.find((c) => c.id === id);
}

export function createChannel(
	input: Partial<ChannelDef> & Pick<ChannelDef, "name">,
): ChannelDef {
	const now = new Date().toISOString();
	// order：从未重排过的库全员缺省（按加入顺序）；重排过（有人带 order）则新渠道排最后=max+1
	const hasOrder = store.channels.some((x) => x.order !== undefined);
	const c: ChannelDef = {
		id: (input.id || genId("ch")).trim(),
		name: input.name.trim(),
		baseUrl: strip(input.baseUrl || ""),
		apiKey: input.apiKey || "",
		enabled: input.enabled ?? true,
		note: input.note || "",
		order: hasOrder ? store.channels.reduce((mx, x) => Math.max(mx, x.order ?? 0), 0) + 1 : undefined,
		createdAt: now,
		updatedAt: now,
	};
	const idx = store.channels.findIndex((x) => x.id === c.id);
	if (idx >= 0) store.channels[idx] = c;
	else store.channels.push(c);
	persist();
	return c;
}

export function updateChannel(
	id: string,
	patch: Partial<Omit<ChannelDef, "id" | "createdAt">>,
): ChannelDef | undefined {
	const c = getChannel(id);
	if (!c) return undefined;
	if (patch.baseUrl !== undefined) patch.baseUrl = strip(patch.baseUrl);
	Object.assign(c, patch, { updatedAt: new Date().toISOString() });
	persist();
	return c;
}

/**
 * 按 id 数组整体重排（第165轮管理端卡片拖动排序）：列表内按新序 1..n，未列出的保持相对序排其后。
 * 仅影响管理端显示顺序（渠道不下发客户端）。
 */
export function reorderChannels(ids: string[]): boolean {
	const pos = new Map(ids.map((id, i) => [id, i]));
	if (!store.channels.some((c) => pos.has(c.id))) return false;
	const listed = store.channels.filter((c) => pos.has(c.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
	const rest = store.channels.filter((c) => !pos.has(c.id)).sort((a, b) => ord(a) - ord(b));
	let n = 0;
	const at = new Date().toISOString();
	for (const c of [...listed, ...rest]) {
		c.order = ++n;
		c.updatedAt = at;
	}
	persist();
	return true;
}

export function deleteChannel(id: string): boolean {
	const before = store.channels.length;
	store.channels = store.channels.filter((c) => c.id !== id);
	if (store.channels.length !== before) {
		if (BUILTIN_CHANNEL_IDS.has(id)) {
			store.deletedSeedIds ??= [];
			if (!store.deletedSeedIds.includes(id)) store.deletedSeedIds.push(id);
		}
		persist();
		return true;
	}
	return false;
}
