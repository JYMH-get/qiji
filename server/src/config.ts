/**
 * 环境配置读取。
 *
 * 上游是一个聚合网关（g-aisc），用同一把 sk- 密钥、Authorization: Bearer，
 * 同时兼容三种协议：OpenAI(/v1/chat/completions, /v1/images/*)、
 * Anthropic(/v1/messages)、Gemini(/v1beta/models/{model}:generateContent)。
 * 因此默认三协议共用一个 baseUrl + key；如需分流再用各自的环境变量覆盖。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 简易 .env 加载（仅在变量未设置时填充，避免覆盖真实环境）
function loadDotEnv(): void {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const envPath = join(here, "..", ".env");
		const raw = readFileSync(envPath, "utf8");
		for (const line of raw.split(/\r?\n/)) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
			if (!m) continue;
			const key = m[1];
			let val = m[2];
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			if (process.env[key] === undefined) process.env[key] = val;
		}
	} catch {
		/* 没有 .env 文件时忽略 */
	}
}
loadDotEnv();

const strip = (u: string) => u.replace(/\/+$/, "");

/** OSS（S3 兼容）配置；publicBase 默认 https://<bucket>.<host>，可用 OSS_PUBLIC_BASE 覆盖（CDN） */
function ossConfig() {
	const endpoint = strip(process.env.OSS_ENDPOINT ?? "");
	const bucket = process.env.OSS_BUCKET ?? "";
	const host = endpoint.replace(/^https?:\/\//, "");
	const publicBase = strip(process.env.OSS_PUBLIC_BASE ?? (endpoint && bucket ? `https://${bucket}.${host}` : ""));
	return {
		endpoint,
		bucket,
		accessKeyId: process.env.OSS_ACCESS_KEY_ID ?? "",
		secretAccessKey: process.env.OSS_SECRET_ACCESS_KEY ?? "",
		region: process.env.OSS_REGION ?? "auto",
		publicBase,
	};
}

const gatewayBaseUrl = strip(process.env.GATEWAY_BASE_URL ?? "https://sub.g-aisc.com");
const gatewayApiKey = process.env.GATEWAY_API_KEY ?? "";

export const config = {
	port: Number(process.env.PORT ?? 8787),
	/** 节点角色（P3 渠道商独立部署）：source=源站（缺省，现行为）；relay=渠道节点——
	 *  本地只保留用户体系（注册/积分/团队/日志），生成与素材全部转发源站，凭 nodeKey 计费到商积分池。 */
	role: (process.env.NODE_ROLE === "relay" ? "relay" : "source") as "source" | "relay",
	/** relay 模式的源站对接（source 模式忽略）：SOURCE_URL=源站地址、SOURCE_NODE_KEY=ank- 节点密钥 */
	source: {
		url: strip(process.env.SOURCE_URL ?? ""),
		nodeKey: process.env.SOURCE_NODE_KEY ?? "",
	},
	/** 管理端控制台令牌（/admin 与 /admin-api 鉴权）。默认 admin-dev，请在生产覆盖。 */
	adminToken: process.env.ADMIN_TOKEN ?? "admin-dev",
	/** 首次启动若用户库为空，用它创建一个默认用户的 accessKey（兼容现有联调） */
	seedAccessKey: process.env.SEED_ACCESS_KEY ?? "dev-key",
	gateway: { baseUrl: gatewayBaseUrl, apiKey: gatewayApiKey },
	// 三协议默认走网关；可分别覆盖
	openai: {
		baseUrl: strip(process.env.OPENAI_BASE_URL ?? gatewayBaseUrl),
		apiKey: process.env.OPENAI_API_KEY ?? gatewayApiKey,
	},
	anthropic: {
		baseUrl: strip(process.env.ANTHROPIC_BASE_URL ?? gatewayBaseUrl),
		apiKey: process.env.ANTHROPIC_API_KEY ?? gatewayApiKey,
	},
	gemini: {
		baseUrl: strip(process.env.GEMINI_BASE_URL ?? gatewayBaseUrl),
		apiKey: process.env.GEMINI_API_KEY ?? gatewayApiKey,
	},
	// 简梦 JA 视频渠道（独立网关 + 独立 sk- 密钥；异步 submit+poll）
	jianmeng: {
		baseUrl: strip(process.env.JIANMENG_BASE_URL ?? "https://api.jian1.vip"),
		apiKey: process.env.JIANMENG_API_KEY ?? "",
	},
	// 火山引擎 AI MediaKit（视频超分/去字幕等智能处理；异步 submit+poll；密钥=控制台 API Key）
	volc: {
		baseUrl: strip(process.env.VOLC_BASE_URL ?? "https://mediakit.cn-beijing.volces.com"),
		apiKey: process.env.VOLC_API_KEY ?? "",
	},
	// 苏打水（简梦三模式）视频渠道（异步 submit+poll；素材上传另走 files 域，见 translators/sudashui.ts）
	sudashui: {
		baseUrl: strip(process.env.SUDASHUI_BASE_URL ?? "https://api.sudashuiapi.com"),
		apiKey: process.env.SUDASHUI_API_KEY ?? "",
	},
	// 星辰（AIStartLab OpenAPI）视频渠道（第132轮；异步 submit+poll，统一生成协议，见 translators/aistars.ts）
	aistars: {
		baseUrl: strip(process.env.AISTARS_BASE_URL ?? "https://api.video.aistarslab.com/openapi"),
		apiKey: process.env.AISTARS_API_KEY ?? "",
	},
	// 画影（AI-Studio aixyzz）视频渠道（第133轮；异步 submit+poll，见 translators/huaying.ts）
	huaying: {
		baseUrl: strip(process.env.HUAYING_BASE_URL ?? "https://ai-studio.aixyzz.com/v1"),
		apiKey: process.env.HUAYING_API_KEY ?? "",
	},
	// Dimensio（jimeng.dimensio.cn）视频渠道（第134轮；异步 submit+poll，见 translators/dimensio.ts）
	dimensio: {
		baseUrl: strip(process.env.DIMENSIO_BASE_URL ?? "https://jimeng.dimensio.cn"),
		apiKey: process.env.DIMENSIO_API_KEY ?? "",
	},
	// Aivide 2.0（aivideo.beauty）视频渠道（第139轮；异步 submit+poll，见 translators/aivide.ts）
	aivide: {
		baseUrl: strip(process.env.AIVIDE_BASE_URL ?? "https://aivideo.beauty"),
		apiKey: process.env.AIVIDE_API_KEY ?? "",
	},
	// 简梦P（Sora/Veo 系）视频渠道（第147轮；异步 submit+poll，见 translators/jianmengp.ts）。
	// ⚠ 上游文档未给 Base URL——默认留空，部署后在管理端「简梦P」渠道填地址+sk- 密钥（或用环境覆盖）。
	jianmengp: {
		baseUrl: strip(process.env.JIANMENGP_BASE_URL ?? ""),
		apiKey: process.env.JIANMENGP_API_KEY ?? "",
	},
	// 简梦M（MuseAI museai.vip）视频渠道（第151轮；异步 submit+poll，apikey 头鉴权，见 translators/musem.ts）
	musem: {
		baseUrl: strip(process.env.MUSEM_BASE_URL ?? "https://museai.vip"),
		apiKey: process.env.MUSEM_API_KEY ?? "",
	},
	// 简梦Z（zexitongxue.com）视频渠道（第152轮；异步 submit+poll，Bearer 鉴权，见 translators/jmz.ts）。
	// ⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos）。
	jmz: {
		baseUrl: strip(process.env.JMZ_BASE_URL ?? "https://zexitongxue.com"),
		apiKey: process.env.JMZ_API_KEY ?? "",
	},
	// Skylee（api.808relay.com）图片渠道（第229轮；异步 submit+poll，Bearer 鉴权，见 translators/relay808.ts）。
	// ⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/images/generations、/v1/images/tasks）。
	skylee: {
		baseUrl: strip(process.env.SKYLEE_BASE_URL ?? "https://api.808relay.com"),
		apiKey: process.env.SKYLEE_API_KEY ?? "",
	},
	// 简梦H（ZhengAPI zhengapi.top）图片渠道（第154轮；同步单请求，Bearer 鉴权，见 translators/jmh.ts）
	jmh: {
		baseUrl: strip(process.env.JMH_BASE_URL ?? "https://zhengapi.top"),
		apiKey: process.env.JMH_API_KEY ?? "",
	},
	// 简梦T（llm.chre3.com：sd2-c8）视频渠道（第160轮；异步 submit+poll，Bearer 鉴权，见 translators/jmt.ts）。
	// ⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos）。
	jmt: {
		baseUrl: strip(process.env.JMT_BASE_URL ?? "https://llm.chre3.com"),
		apiKey: process.env.JMT_API_KEY ?? "",
	},
	// 简梦F（new.vosle.xyz：Seedance 2.0）视频渠道（第161轮；异步 submit+poll，Bearer 鉴权，见 translators/jmf.ts）。
	// ⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos）。
	jmf: {
		baseUrl: strip(process.env.JMF_BASE_URL ?? "https://new.vosle.xyz"),
		apiKey: process.env.JMF_API_KEY ?? "",
	},
	// 出海营（api.aiid.edu.kg：Seedance 任务格式）视频渠道（第186轮；异步 submit+poll，Bearer 鉴权，见 translators/overseas.ts）。
	// ⚠ Base URL 填根域（翻译器自拼 /api/v3/contents/generations/tasks）。
	overseas: {
		baseUrl: strip(process.env.OVERSEAS_BASE_URL ?? "https://api.aiid.edu.kg"),
		apiKey: process.env.OVERSEAS_API_KEY ?? "",
	},
	// 算力（xienlive.com·OctopusAI：MiniMax H3）视频渠道（第217轮；异步 submit+poll，Bearer sk- 鉴权，见 translators/suanli.ts）。
	// ⚠ Base URL 填根域（翻译器自拼 /api/v1/video/generate|generate-flf|query）。
	suanli: {
		baseUrl: strip(process.env.SUANLI_BASE_URL ?? "https://xienlive.com"),
		apiKey: process.env.SUANLI_API_KEY ?? "",
	},
	// Yali AI Studio（api.yaliai.com）图片渠道（第229轮；同步单请求 OpenAI Images 形态，Bearer 鉴权，见 translators/yali.ts）。
	// ⚠ Base URL 填根域（翻译器自拼 /v1/images/generations|edits）。
	// ⚠ **一把 Key 绑定一种接口类型**（OpenAI Images / Banana·Gemini 各一把）——环境变量只能兜底一类，
	//    两类都要用时必须在管理端两个渠道（ch-yali-openai / ch-yali-gemini）各自填 Key。
	yali: {
		baseUrl: strip(process.env.YALI_BASE_URL ?? "https://api.yaliai.com"),
		apiKey: process.env.YALI_API_KEY ?? "",
	},
	// congge（congchen.top·聪宸）图片+视频渠道（第233轮；图片=同步单请求、视频=异步 submit+poll，
	// 两者同一把 Bearer sk-，见 translators/congge.ts）。⚠ Base URL 填根域不带 /v1
	// （翻译器自拼 /v1/images/generations|edits、/v1/videos）。
	congge: {
		baseUrl: strip(process.env.CONGGE_BASE_URL ?? "https://congchen.top"),
		apiKey: process.env.CONGGE_API_KEY ?? "",
	},
	// BYS（www.boyesir.icu·Boyesir AI）视频渠道（第252轮；异步 submit+poll，见 translators/bys.ts）。
	// ⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos/generations 与 /v1/tasks/{task_id}）；
	//    鉴权 Bearer sk-（站点控制台 → 令牌创建）。
	bys: {
		baseUrl: strip(process.env.BYS_BASE_URL ?? "https://www.boyesir.icu"),
		apiKey: process.env.BYS_API_KEY ?? "",
	},
	// QiQi（pidoi.com·Seedance 官转 API）视频渠道（第255轮；异步 submit+poll，见 translators/qiqi.ts）。
	// ⚠ Base URL 填根域不带 /v1（翻译器自拼 /v1/videos、/v1/videos/{task_id}、/v1/videos/{id}/content）；
	//    鉴权 Bearer sk-（站点控制台→令牌创建，New API 系网关）。
	qiqi: {
		baseUrl: strip(process.env.QIQI_BASE_URL ?? "https://pidoi.com"),
		apiKey: process.env.QIQI_API_KEY ?? "",
	},
	// 「官方」dreamina Seedance 2.0/2.5（kwjm.com；Bearer；异步 submit+poll）。
	official: {
		baseUrl: strip(process.env.OFFICIAL_BASE_URL ?? "https://kwjm.com"),
		apiKey: process.env.OFFICIAL_API_KEY ?? "",
	},
	// autodl（autodl.art·ComfyUI 工作流平台）视频渠道（第234轮；异步 submit+poll，见 translators/autodl.ts）。
	// ⚠ 鉴权=Authorization 原样 Token（**不带 Bearer 前缀**，控制台「令牌管理」创建、分组选 ComfyUI）；
	//    Base URL 填根域（翻译器自拼 /api/v1/comfyui/comfyui_workflow/{workflow_id} 与 /result/{task_id}）。
	autodl: {
		baseUrl: strip(process.env.AUTODL_BASE_URL ?? "https://autodl.art"),
		apiKey: process.env.AUTODL_API_KEY ?? "",
	},
	// 奇迹云（自建 autodl 云实例池 + ComfyUI 直驱；第249轮，见 store/qijicloudPool.ts + translators/qijicloud.ts）。
	// ⚠ apiKey=autodl **开发者Token**（autodl.com 控制台→设置→开发者Token；原样 Authorization 无 Bearer）——
	//    与 autodl 模式（上面那条）的 ComfyUI 令牌是**两把不同 token**，勿混填。
	qijicloud: {
		baseUrl: strip(process.env.QIJICLOUD_BASE_URL ?? "https://www.autodl.art"),
		apiKey: process.env.QIJICLOUD_DEV_TOKEN ?? "",
	},
	// OSS 对象存储（S3 兼容；资产/项目云备份，公有读直链）
	oss: ossConfig(),
};

export const hasOpenAI = () => !!config.openai.apiKey;
export const hasAnthropic = () => !!config.anthropic.apiKey;
export const hasGemini = () => !!config.gemini.apiKey;
