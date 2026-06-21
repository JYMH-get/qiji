/**
 * 管理端可配设置（落盘 data/settings.json）。
 *
 * 目前承载 OSS 对象存储配置：优先用管理端在 /admin 里填的值，未填则回退 .env(config.oss)。
 * 与模型 apiKey 一样，密钥只存服务端（gitignore 的 data/），用户端永不接触。
 */
import { loadJson, saveJson } from "./db.ts";
import { config } from "../config.ts";

const FILE = "settings.json";
const strip = (u: string) => (u || "").replace(/\/+$/, "");

export interface OssSettings {
	endpoint?: string;
	bucket?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	region?: string;
	publicBase?: string;
}
interface Settings {
	oss?: OssSettings;
}

const settings: Settings = loadJson<Settings>(FILE, {});
let _version = 0; // OSS 配置变更计数（oss.ts 据此重建 S3 客户端）

export function ossConfigVersion(): number {
	return _version;
}

/** 解析生效的 OSS 配置：管理端值 ?? .env 默认；publicBase 默认 https://<bucket>.<host> */
export function getOssConfig() {
	const o = settings.oss ?? {};
	const endpoint = strip(o.endpoint ?? config.oss.endpoint);
	const bucket = o.bucket ?? config.oss.bucket;
	const host = endpoint.replace(/^https?:\/\//, "");
	const publicBase = strip(o.publicBase || (endpoint && bucket ? `https://${bucket}.${host}` : config.oss.publicBase));
	return {
		endpoint,
		bucket,
		accessKeyId: o.accessKeyId ?? config.oss.accessKeyId,
		secretAccessKey: o.secretAccessKey ?? config.oss.secretAccessKey,
		region: o.region ?? config.oss.region,
		publicBase,
	};
}

/** 管理端更新 OSS 配置（仅合并传入字段；落盘 + 触发客户端重建） */
export function setOssConfig(patch: OssSettings): void {
	settings.oss = { ...(settings.oss ?? {}), ...patch };
	saveJson(FILE, settings);
	_version += 1;
}
