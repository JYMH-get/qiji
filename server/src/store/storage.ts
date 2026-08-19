/**
 * 存储档（storage profile）——「资产行 → 该去哪个桶、用什么对象键」的唯一解析入口。
 *
 * 背景：以前全站只有一个桶、一个 `assets/` 平铺前缀，所有代码里的桶都直接取
 * `getOssConfig().bucket`、键都直接拼 `assets/<id>.<ext>`。要换桶 / 换目录布局
 * （做素材库分类、按 kind/yyyy/mm 分片、给 lifecycle 规则分前缀）就得满仓库改。
 *
 * 现在每行资产带一个 `storage` 档位（`assets.storage` 列，NULL 一律按 'legacy' 解读），
 * 由本模块把档位解析成 { 桶, 对象键, 公网前缀 }：
 *  - **老对象照常可访问**：键不变、桶不变，档只是把"它属于哪套布局"记下来；
 *  - **新增一档 = 改配置**，不动代码（settings.json 的 storageProfiles）。
 *
 * ⚠ 对象键一旦分配就**永不改变**——键即公网直链，改键=所有存量引用全部失效。
 *   `oss_key` 列是例外通道：非空时一律优先，本模块的推导只用于它为空的兜底。
 */
import { loadJson } from "./db.ts";
import { getOssConfig } from "./settings.ts";

/** 对象键布局 */
export type StorageLayout = "flat" | "kind/yyyy/mm" | "acct/kind/yyyy/mm/dd";

export interface StorageProfile {
	id: string;
	endpoint: string;
	bucket: string;
	publicBase: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	layout: StorageLayout;
	/** 是否允许写入新对象（老档换掉后置 false，只读不写） */
	writable: boolean;
	/** 新资产落哪一档（有且只应有一个 active） */
	active: boolean;
}

/** settings.json 里的档位配置（字段可缺省，缺的从主 OSS 配置继承） */
interface ProfileConfig {
	endpoint?: string;
	bucket?: string;
	publicBase?: string;
	region?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	layout?: StorageLayout;
	writable?: boolean;
	active?: boolean;
}

export const LEGACY = "legacy";

const strip = (u: string) => (u || "").replace(/\/+$/, "");

/**
 * 解析全部档位。**永远含 legacy**（现状：主 OSS 配置 + `assets/` 平铺 + 可写 + 激活），
 * 所以未配 storageProfiles 时行为与改造前完全一致。
 *
 * 每次调用现读 settings.json（低频路径：只在资产创建/自愈/删除时走），
 * 管理端改配置即时生效，无需重启。
 */
export function getProfiles(): Record<string, StorageProfile> {
	const base = getOssConfig();
	const raw = loadJson<{ storageProfiles?: Record<string, ProfileConfig> }>("settings.json", {}).storageProfiles ?? {};
	const out: Record<string, StorageProfile> = {};
	const build = (id: string, c: ProfileConfig): StorageProfile => {
		const endpoint = strip(c.endpoint ?? base.endpoint);
		const bucket = c.bucket ?? base.bucket;
		const host = endpoint.replace(/^https?:\/\//, "");
		return {
			id,
			endpoint,
			bucket,
			publicBase: strip(c.publicBase || (endpoint && bucket ? `https://${bucket}.${host}` : base.publicBase)),
			region: c.region ?? base.region,
			accessKeyId: c.accessKeyId ?? base.accessKeyId,
			secretAccessKey: c.secretAccessKey ?? base.secretAccessKey,
			layout: c.layout ?? "flat",
			writable: c.writable !== false,
			active: c.active === true,
		};
	};
	for (const [id, c] of Object.entries(raw)) out[id] = build(id, c ?? {});
	// legacy 兜底：未显式配置时 = 当前主 OSS 配置 + 平铺 + 可写可激活（=改造前的行为）
	if (!out[LEGACY]) out[LEGACY] = build(LEGACY, { layout: "flat", writable: true, active: !Object.values(out).some((p) => p.active) });
	return out;
}

/** 新资产落哪一档：唯一 active 且 writable 的档；都没有则 legacy */
export function activeProfile(): StorageProfile {
	const all = getProfiles();
	const hit = Object.values(all).find((p) => p.active && p.writable);
	return hit ?? all[LEGACY];
}

/** 按档位 id 取档；未知档位一律回落 legacy（存量 NULL 也走这里） */
export function profileOf(storage?: string | null): StorageProfile {
	const all = getProfiles();
	return all[storage || LEGACY] ?? all[LEGACY];
}

/** 资产类型 → 目录分片用的 kind 段（仅 kind/yyyy/mm 布局用） */
function kindOf(type: string, prefix: string): string {
	if (prefix === "TP") return "tmp";
	if (type === "video") return "video";
	if (type === "audio") return "audio";
	if (type === "text") return "text";
	return "image";
}

/**
 * 按档位推导对象键。**只在 `oss_key` 为空时兜底用**——非空的 oss_key 永远优先。
 *  - flat                → `assets/<id>.<ext>`（改造前的唯一形态）
 *  - kind/yyyy/mm        → `<kind>/<yyyy>/<mm>/<id>.<ext>`（分前缀，便于 lifecycle 按类型/月份设规则）
 *  - acct/kind/yyyy/mm/dd→ `<账号>/<kind>/<yyyy>/<mm>/<dd>/<id>.<ext>`（第224轮用户定稿：
 *    月份目录几十万张没法查阅——精确到「谁生成的用谁账号」+ 天。acct 由调用方传入
 *    （createAsset 按归属上下文解析登录账号并 ASCII 归一），缺省 "anon"）
 */
export function keyFor(profile: StorageProfile, opts: { id: string; ext: string; type: string; createdAt?: string; acct?: string }): string {
	const { id, ext, type } = opts;
	if (profile.layout === "kind/yyyy/mm" || profile.layout === "acct/kind/yyyy/mm/dd") {
		const d = opts.createdAt ? new Date(opts.createdAt) : new Date();
		const yyyy = String(d.getUTCFullYear());
		const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
		const prefix = /^[A-Za-z]{1,12}/.exec(id)?.[0] ?? "";
		const base = `${kindOf(type, prefix)}/${yyyy}/${mm}`;
		if (profile.layout === "acct/kind/yyyy/mm/dd") {
			const dd = String(d.getUTCDate()).padStart(2, "0");
			return `${opts.acct || "anon"}/${base}/${dd}/${id}.${ext}`;
		}
		return `${base}/${id}.${ext}`;
	}
	return `assets/${id}.${ext}`;
}

/** 对象的公网直链（按档的 publicBase） */
export function publicUrlOf(profile: StorageProfile, key: string): string {
	return `${profile.publicBase}/${key.replace(/^\/+/, "")}`;
}

/**
 * 定位一行资产的实际存储位置：档 + 桶 + 对象键。
 * 键取 `rec.ossKey`（例外通道，永远优先）；为空才按档推导。
 */
export function locate(rec: { id: string; type: string; contentType?: string; ossKey?: string; storage?: string; createdAt?: string }, ext: string) {
	const profile = profileOf(rec.storage);
	const key = rec.ossKey || keyFor(profile, { id: rec.id, ext, type: rec.type, createdAt: rec.createdAt });
	return { profile, key, url: publicUrlOf(profile, key) };
}
