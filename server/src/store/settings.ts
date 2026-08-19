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
	// codePricing / defaultAgentCostPricing / defaultAgentCodePricing / teamCodePrice：
	// P1 经济模型翻转（统一定价+免费码）后废弃——键在存量 settings.json 里无害残留，代码不再读写。
	/** 团队人数上限（第173轮，**含团长**）：全局默认，管理端「团队」页可改；每团可单独覆盖（Team.memberLimit）。
	 *  未设/非法=默认 50。 */
	teamMemberLimit?: number;
	/** 个人收藏配额（P1，字节）：收藏=永久保留额度。未设=200MB。可按用户覆盖 User.favQuotaBytes */
	favQuotaBytes?: number;
	/** 团队共享库配额（P1，字节）：未设=2GB。可按团覆盖 Team.libQuotaBytes */
	teamLibQuotaBytes?: number;
	/** 扩容卡规格：个人/团队各一档（P1 商业化改造起签发免费，price 字段保留供后续升级收费用） */
	storageCode?: { user?: StorageCodeSpec; team?: StorageCodeSpec };
	/** 注册体系（P2 商业化改造）：开关/赠送/频控/黑名单/SMTP/短信 */
	register?: RegisterSettings;
	/** 同账号同时在线设备数上限（P2）：未设=默认 1；0=不限。可按用户覆盖 User.deviceLimit */
	deviceLimit?: number;
}

/** 注册体系配置（管理端「注册与安全」页维护；密钥只存服务端） */
export interface RegisterSettings {
	/** 注册开关（缺省=开；关=注册端点明确拒绝，存量登录不受影响） */
	enabled?: boolean;
	/** 注册赠送积分（缺省 0；机制保留供后续邀请码/运营活动，>0 时建议同时收紧 IP 限额） */
	giftCredits?: number;
	/** 同 IP 每日注册上限（缺省 5） */
	ipRegPerDay?: number;
	/** 同 IP 发验证码上限：每小时（缺省 10）/ 每天（缺省 20） */
	ipSendPerHour?: number;
	ipSendPerDay?: number;
	/** 邮箱域黑名单追加（内置常见临时邮箱域之外；小写域名数组） */
	emailDomainBlacklist?: string[];
	/** SMTP（邮箱验证码通道；未配=邮箱注册不可用，注册页明确报「暂未开放」） */
	smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass?: string; from?: string };
	/** 短信（手机号验证码通道；未配=手机号注册不可用）。目前支持阿里云短信 */
	sms?: { provider?: "aliyun"; accessKeyId?: string; accessKeySecret?: string; signName?: string; templateCode?: string };
}

/** 扩容卡规格：一张卡给多少容量、有效几天（price 保留字段，P1 起签发免费不扣） */
export interface StorageCodeSpec {
	bytes: number;
	days: number;
	price: number;
}

const settings: Settings = loadJson<Settings>(FILE, {});
let _version = 0; // OSS 配置变更计数（oss.ts 据此重建 S3 客户端）

// ⚠ settings.json 是多模块共写的文件（retention.ts 的 retentionDays 也落在这里，且它是
// 现读现写）。本模块持有的 `settings` 是**启动时快照**——落盘时只允许覆盖自己拥有的键，
// 其余键一律以磁盘现值为准。否则「启动后别的模块写进去的键」会被这里的旧快照静默抹掉
// （第223轮实锤的事故面：清理存量特赦把 ref 档抬到 30 天写进 retentionDays，若之后管理端
// 随手保存一次 OSS 配置就被抹回 14 天 = 存量保护提前失效、清理任务会提前开删）。
const OWN_KEYS = ["oss", "teamMemberLimit", "favQuotaBytes", "teamLibQuotaBytes", "storageCode", "register", "deviceLimit"] as const;
function persist(): void {
	const disk = loadJson<Record<string, unknown>>(FILE, {});
	for (const k of OWN_KEYS) {
		const v = (settings as Record<string, unknown>)[k];
		if (v === undefined) delete disk[k];
		else disk[k] = v;
	}
	saveJson(FILE, disk);
}

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
	persist();
	_version += 1;
}

// ── 团队人数上限（第173轮，含团长）──

const TEAM_LIMIT_DEFAULT = 50;
/** 收敛人数上限输入：2–500 的整数；其余（空/0/非法）=无效（返回 undefined，语义=跟随默认） */
export function normTeamLimit(v: unknown): number | undefined {
	const n = Math.floor(Number(v) || 0);
	return n >= 2 ? Math.min(n, 500) : undefined;
}
/** 全局默认团队人数上限（含团长；未设=50）。每团可用 Team.memberLimit 单独覆盖。 */
export function getTeamMemberLimit(): number {
	return normTeamLimit(settings.teamMemberLimit) ?? TEAM_LIMIT_DEFAULT;
}
/** 设置全局默认团队人数上限：非法/空=清除恢复默认 50。返回生效值。 */
export function setTeamMemberLimit(v: unknown): number {
	settings.teamMemberLimit = normTeamLimit(v);
	persist();
	return getTeamMemberLimit();
}

// ── 存储配额与扩容卡（P1）──

const FAV_QUOTA_DEFAULT = 200 * 1024 * 1024; // 个人 200MB
const TEAM_LIB_QUOTA_DEFAULT = 2 * 1024 * 1024 * 1024; // 团队 2GB
const STORAGE_CODE_DEFAULT: { user: StorageCodeSpec; team: StorageCodeSpec } = {
	user: { bytes: 200 * 1024 * 1024, days: 30, price: 300 },
	team: { bytes: 1024 * 1024 * 1024, days: 30, price: 1000 },
};

/** 收敛字节数输入：正整数；非法/空=undefined（跟随默认）。上限 1TB 防手滑多打几个 0 */
function normBytes(v: unknown): number | undefined {
	const n = Math.floor(Number(v) || 0);
	return n > 0 ? Math.min(n, 1024 ** 4) : undefined;
}

/** 个人收藏配额（字节）；未设=200MB */
export function getFavQuotaBytes(): number {
	return normBytes(settings.favQuotaBytes) ?? FAV_QUOTA_DEFAULT;
}
/** 团队共享库配额（字节）；未设=2GB */
export function getTeamLibQuotaBytes(): number {
	return normBytes(settings.teamLibQuotaBytes) ?? TEAM_LIB_QUOTA_DEFAULT;
}
/** 设置配额：null/空/非法=清除恢复默认。返回生效值 */
export function setFavQuotaBytes(v: unknown): number {
	settings.favQuotaBytes = normBytes(v);
	persist();
	return getFavQuotaBytes();
}
export function setTeamLibQuotaBytes(v: unknown): number {
	settings.teamLibQuotaBytes = normBytes(v);
	persist();
	return getTeamLibQuotaBytes();
}

/** 扩容卡规格（缺省档位见 STORAGE_CODE_DEFAULT；⚠ price 显式 0 = 免费签发，勿 truthy 判断） */
export function getStorageCodeSpec(target: "user" | "team"): StorageCodeSpec {
	const d = STORAGE_CODE_DEFAULT[target];
	const c = settings.storageCode?.[target];
	if (!c) return d;
	const price = Number.isFinite(Number(c.price)) && Number(c.price) >= 0 ? Math.floor(Number(c.price)) : d.price;
	return { bytes: normBytes(c.bytes) ?? d.bytes, days: Math.max(1, Math.floor(Number(c.days) || 0)) || d.days, price };
}
/** 更新扩容卡规格（部分字段合并；传 null 清除该档恢复默认） */
export function setStorageCodeSpec(target: "user" | "team", patch: Partial<StorageCodeSpec> | null): StorageCodeSpec {
	if (!settings.storageCode) settings.storageCode = {};
	if (!patch) delete settings.storageCode[target];
	else settings.storageCode[target] = { ...getStorageCodeSpec(target), ...patch };
	if (Object.keys(settings.storageCode).length === 0) delete settings.storageCode;
	persist();
	return getStorageCodeSpec(target);
}

// （P1 移除：激活码签发价 CODE_PRICE_TIERS/getCodePricing/setCodePricing、
//   源站默认渠道商价 getDefaultAgentCostPricing 一族——统一定价+免费码后无消费方）

// ── 注册体系（P2 商业化改造）──

const posInt = (v: unknown, def: number, max: number): number => {
	const n = Math.floor(Number(v));
	return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : def;
};

/** 生效注册配置（各字段带缺省归一；密钥原样返回——仅服务端内部消费，对外下发前须脱敏） */
export function getRegisterSettings(): Required<Pick<RegisterSettings, "enabled" | "giftCredits" | "ipRegPerDay" | "ipSendPerHour" | "ipSendPerDay" | "emailDomainBlacklist">> & Pick<RegisterSettings, "smtp" | "sms"> {
	const r = settings.register ?? {};
	return {
		enabled: r.enabled !== false,
		giftCredits: posInt(r.giftCredits, 0, 1_000_000),
		ipRegPerDay: posInt(r.ipRegPerDay, 5, 10_000) || 5,
		ipSendPerHour: posInt(r.ipSendPerHour, 10, 10_000) || 10,
		ipSendPerDay: posInt(r.ipSendPerDay, 20, 10_000) || 20,
		emailDomainBlacklist: Array.isArray(r.emailDomainBlacklist) ? r.emailDomainBlacklist.map((d) => String(d).trim().toLowerCase()).filter(Boolean) : [],
		smtp: r.smtp,
		sms: r.sms,
	};
}

/** 更新注册配置（部分合并；smtp.pass / sms.accessKeySecret 传空串=不改，传 null=清除） */
export function setRegisterSettings(patch: RegisterSettings): void {
	const cur = settings.register ?? {};
	const next: RegisterSettings = { ...cur, ...patch };
	// 嵌套对象合并 + 密钥「空串不改」语义（管理端表单密钥框留空=保持原值）
	if (patch.smtp !== undefined) {
		const smtp = { ...(cur.smtp ?? {}), ...(patch.smtp ?? {}) };
		if (patch.smtp && (patch.smtp as Record<string, unknown>).pass === "") smtp.pass = cur.smtp?.pass;
		next.smtp = smtp;
	}
	if (patch.sms !== undefined) {
		const sms = { ...(cur.sms ?? {}), ...(patch.sms ?? {}) };
		if (patch.sms && (patch.sms as Record<string, unknown>).accessKeySecret === "") sms.accessKeySecret = cur.sms?.accessKeySecret;
		next.sms = sms;
	}
	settings.register = next;
	persist();
}

/** 同账号同时在线设备数上限（全局默认）：未设=1（登录抢占制）；0=不限 */
export function getDeviceLimit(): number {
	const n = Math.floor(Number(settings.deviceLimit));
	return Number.isFinite(n) && n >= 0 && settings.deviceLimit != null ? Math.min(n, 100) : 1;
}
/** 设置设备上限：null/空=恢复默认 1；0=不限。返回生效值 */
export function setDeviceLimit(v: unknown): number {
	if (v == null || v === "") {
		settings.deviceLimit = undefined;
	} else {
		const n = Math.floor(Number(v));
		settings.deviceLimit = Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : undefined;
	}
	persist();
	return getDeviceLimit();
}
