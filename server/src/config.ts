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
	// OSS 对象存储（S3 兼容；资产/项目云备份，公有读直链）
	oss: ossConfig(),
};

export const hasOpenAI = () => !!config.openai.apiKey;
export const hasAnthropic = () => !!config.anthropic.apiKey;
export const hasGemini = () => !!config.gemini.apiKey;
