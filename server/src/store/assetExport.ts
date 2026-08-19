/**
 * 批量下载清单（第232轮）——把请求记录里的成功产物链接，按 时间/用户/类型/保存情况
 * 摊平成一份可供下载器直接消费的清单。
 *
 * 为什么数据源是**请求记录**而不是资产台账：
 *   转存成功的产物在 assets 台账里有行（OSS 直链，用户自己就能下）；
 *   而**转存失败回退的上游原链**（translators/index.ts 的 `rehosted:false` 分支）压根不入台账
 *   （那条结果的 id 是 `vid-<上游任务号>` 这种伪 id），它只存在于日志的 resultLink 里。
 *   用户真正需要抢救的恰恰是后者，所以清单必须从 logs 索引出发。
 *
 * ⚠ 原链是**时效链接**：各家从 2 小时（简梦Z 图片）到 24 小时（火山/简梦F）不等，
 *   日志留 30 天但链接早死了。所以本清单的定位是「尽快抢救」，不是「历史归档」——
 *   `expiryRisk` 字段按记录年龄给出风险档，下载器据此优先抓新的。
 *
 * ⚠ 部分渠道的原链**下载须带上游 Bearer**（简梦F/简梦Z 图片/出海营/Skylee，见各翻译器 resultHeaders），
 *   而我方硬规则是「密钥只对本站域附头、绝不外发」——这类链接直连必然 401/403。
 *   清单以 `authRequired` 明确标注，下载器应直接列为「需服务端代下」而不是反复重试。
 *   判定不靠静态域名清单，而是「结果域 == 该模型所属渠道的 baseUrl 域」——与四个翻译器
 *   附鉴权头的判据完全同构，新接渠道自动覆盖、无需维护第二张表。
 */
import { filterLogs, PURPOSE_LABELS, type LogFilter, type LogMeta } from "./logs.ts";
import { getProfiles } from "./storage.ts";
import { getOssConfig } from "./settings.ts";
import { isBridgeOldUrl } from "./assets.ts";
import { getModelDef } from "./models.ts";
import { getChannel } from "./channels.ts";

/** 保存情况：产物链接指向哪儿 */
export type LinkStorage =
	| "oss" // 我方对象存储直链——永久有效，用户本就能下
	| "oss-old" // 已舍弃的旧桶（第224轮）——对象已不在，下不了
	| "local" // 未配 OSS 时的服务端 /raw 兜底链——须带登录态
	| "raw"; // 上游原链——**有时效**，本功能的主要抢救对象

export type MediaKind = "image" | "video" | "audio" | "other";

/** 原链过期风险档（按记录年龄粗估；oss 档恒 none） */
export type ExpiryRisk = "none" | "low" | "high" | "expired";

export interface DownloadItem {
	logId: string;
	taskId?: string;
	userId?: string;
	/** 用户显示名（未注册用户为空） */
	user: string;
	startedAt: string;
	finishedAt?: string;
	purpose: string; // 原始 purpose key
	purposeLabel: string; // 中文步骤名
	model: string;
	/** 同一条请求记录内的第几个产物（0 基）与总数——多图任务一条记录可能有多个链接 */
	seq: number;
	total: number;
	url: string;
	storage: LinkStorage;
	kind: MediaKind;
	ext: string;
	/** 直连下不了（须带上游鉴权头）→ 下载器应标为「需服务端代下」，勿反复重试 */
	authRequired: boolean;
	expiryRisk: ExpiryRisk;
	/** 建议落盘相对路径：<用户>/<日期>/<步骤>_<logId>[_序号].<ext> */
	suggestedPath: string;
}

export interface DownloadManifest {
	generatedAt: string;
	/** 清单条目总数（= items.length；被截断时 items 更短，见 truncated） */
	total: number;
	/** ⚠ 命中上限被截断时为真——绝不静默截断，调用方须明确告知用户 */
	truncated: boolean;
	/** 截断前的实际匹配数（未截断时 = total） */
	matched: number;
	byStorage: Record<LinkStorage, number>;
	byKind: Record<MediaKind, number>;
	/** 须服务端代下的条目数（直连必失败） */
	authRequired: number;
	items: DownloadItem[];
}

export interface DownloadFilter extends LogFilter {
	/** 保存情况过滤（空/不传=全部） */
	storages?: LinkStorage[];
	/** 媒体类型过滤（空/不传=全部） */
	kinds?: MediaKind[];
	/** 条目上限（防一次几十万条打爆响应）；缺省 50000 */
	limit?: number;
}

/** 单次清单的硬上限——再大响应体本身就成问题，超出请用时间窗切分 */
const MAX_ITEMS = 50000;

// ── 链接分类 ──

const stripSlash = (u: string) => (u || "").replace(/\/+$/, "");

/** 我方 OSS 的全部公网基址（所有存储档 + 主配置），用于判定「已存 OSS」 */
function ossBases(): string[] {
	const out = new Set<string>();
	for (const p of Object.values(getProfiles())) if (p.publicBase) out.add(stripSlash(p.publicBase));
	const main = stripSlash(getOssConfig().publicBase || "");
	if (main) out.add(main);
	return [...out];
}

/** 两个 host 是否同域（含子域，双向）——与各翻译器附鉴权头的判据同构 */
function sameHost(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function hostOf(u: string): string {
	try {
		return new URL(u).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** 该模型的上游地址（优先级与 translators/upstream.ts 一致：模型覆盖 > 渠道） */
function upstreamBaseOf(modelId?: string): string {
	if (!modelId) return "";
	const md = getModelDef(modelId);
	if (!md) return "";
	if (md.baseUrl) return md.baseUrl;
	if (md.channelId) return getChannel(md.channelId)?.baseUrl || "";
	return "";
}

export function classifyLink(url: string): LinkStorage {
	if (!url) return "raw";
	if (isBridgeOldUrl(url)) return "oss-old";
	for (const b of ossBases()) if (b && url.startsWith(b)) return "oss";
	if (/\/v1\/assets\/[^/]+\/raw/.test(url)) return "local";
	return "raw";
}

const IMG_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif", "tiff"]);
const VID_EXT = new Set(["mp4", "mov", "webm", "mkv", "m4v", "avi"]);
const AUD_EXT = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus"]);

/** 从 url 路径末尾取扩展名（剥查询串/锚点）；取不到返回空 */
function extFromUrl(url: string): string {
	let path = url;
	try {
		path = new URL(url).pathname;
	} catch {
		path = url.split(/[?#]/)[0];
	}
	const m = /\.([A-Za-z0-9]{1,5})$/.exec(path);
	return m ? m[1].toLowerCase() : "";
}

/** 媒体大类：先信扩展名，取不到按步骤推（原链常是 /content 这类无扩展名端点） */
export function kindOf(url: string, purpose?: string): MediaKind {
	const ext = extFromUrl(url);
	if (IMG_EXT.has(ext)) return "image";
	if (VID_EXT.has(ext)) return "video";
	if (AUD_EXT.has(ext)) return "audio";
	const p = purpose || "";
	if (p.startsWith("video.")) return "video";
	if (p.startsWith("audio.")) return "audio";
	if (p.startsWith("image.") || p.startsWith("asset.") || p === "storyboard.toImagePrompt") return "image";
	return "other";
}

/** 落盘扩展名：url 里有就用它，没有按大类给个合理默认（下载器可按 Content-Type 再修正） */
function extFor(url: string, kind: MediaKind): string {
	const ext = extFromUrl(url);
	if (ext) return ext;
	return kind === "video" ? "mp4" : kind === "audio" ? "mp3" : kind === "image" ? "png" : "bin";
}

/** 原链过期风险：按记录年龄粗估（各家 2~24h 不等，故 2h 内低风险、24h 内高风险、更久基本已死） */
function expiryRiskOf(storage: LinkStorage, startedAt: string): ExpiryRisk {
	if (storage !== "raw") return "none";
	const t = Date.parse(startedAt);
	if (!Number.isFinite(t)) return "high";
	const ageH = (Date.now() - t) / 3600000;
	if (ageH <= 2) return "low";
	if (ageH <= 24) return "high";
	return "expired";
}

/** 文件名安全化：剔除 Windows/POSIX 非法字符、控制字符与空白，保留中文 */
function safeSeg(s: string, max = 60): string {
	const cleaned = (s || "")
		.replace(new RegExp("[\\u0000-\\u001f\\u007f]", "g"), "") // 控制字符（用 RegExp 构造，源码里不留裸控制字节）
		.replace(/[\\/:*?"<>|]/g, "_") // 路径非法字符
		.replace(/\s+/g, "_") // 空白不进文件名，省得下载器/脚本再转义
		.replace(/^\.+|\.+$/g, "") // 首尾点号（Windows 不允许）
		.trim();
	return (cleaned || "_").slice(0, max);
}

// ── 清单组装 ──

/**
 * 按筛选生成下载清单。
 * 只取 **成功且有产物链接** 的记录；resultLink 里的多个链接（多图任务）逐个摊平成独立条目。
 */
export function buildDownloadManifest(opts?: DownloadFilter): DownloadManifest {
	const limit = Math.min(Math.max(1, opts?.limit ?? MAX_ITEMS), MAX_ITEMS);
	const wantStorage = opts?.storages?.length ? new Set(opts.storages) : null;
	const wantKind = opts?.kinds?.length ? new Set(opts.kinds) : null;

	const byStorage: Record<LinkStorage, number> = { oss: 0, "oss-old": 0, local: 0, raw: 0 };
	const byKind: Record<MediaKind, number> = { image: 0, video: 0, audio: 0, other: 0 };
	let authRequired = 0;
	let matched = 0;
	const items: DownloadItem[] = [];

	// 最新的先出——原链抢救永远是新的更要紧（filterLogs 返回旧→新）
	const logs = filterLogs({ ...opts, status: "success" }).reverse();

	for (const l of logs) {
		const links = splitResultLinks(l.resultLink);
		if (!links.length) continue;
		const upstreamHost = hostOf(upstreamBaseOf(l.model));
		const dayDir = (l.startedAt || "").slice(0, 10) || "unknown";
		const userDir = safeSeg(l.userName || l.userId || "未注册", 40);
		const label = PURPOSE_LABELS[l.purpose || ""] || l.purpose || "产物";

		links.forEach((url, i) => {
			const storage = classifyLink(url);
			const kind = kindOf(url, l.purpose);
			if (wantStorage && !wantStorage.has(storage)) return;
			if (wantKind && !wantKind.has(kind)) return;
			matched += 1;
			if (items.length >= limit) return; // 计数继续，条目不再加（truncated 会如实标注）

			const ext = extFor(url, kind);
			// 需鉴权：原链且结果域 == 该模型所属渠道域（与翻译器附 Bearer 的判据同构）
			const auth = storage === "raw" && !!upstreamHost && sameHost(hostOf(url), upstreamHost);
			const suffix = links.length > 1 ? `_${i + 1}` : "";
			items.push({
				logId: l.id,
				taskId: l.taskId,
				userId: l.userId,
				user: l.userName || "",
				startedAt: l.startedAt,
				finishedAt: l.finishedAt,
				purpose: l.purpose || "",
				purposeLabel: label,
				model: l.model || "",
				seq: i,
				total: links.length,
				url,
				storage,
				kind,
				ext,
				authRequired: auth,
				expiryRisk: expiryRiskOf(storage, l.startedAt),
				suggestedPath: `${userDir}/${dayDir}/${safeSeg(label, 24)}_${l.id}${suffix}.${ext}`,
			});
			byStorage[storage] += 1;
			byKind[kind] += 1;
			if (auth) authRequired += 1;
		});
	}

	return {
		generatedAt: new Date().toISOString(),
		total: items.length,
		truncated: matched > items.length,
		matched,
		byStorage,
		byKind,
		authRequired,
		items,
	};
}

/** resultLink 是多链接用 " | " 拼接的（logs.resultLinkFrom）——拆开并去空 */
export function splitResultLinks(resultLink?: string): string[] {
	if (!resultLink) return [];
	return resultLink
		.split("|")
		.map((s) => s.trim())
		.filter((s) => /^https?:\/\//i.test(s));
}

const STORAGES: LinkStorage[] = ["oss", "oss-old", "local", "raw"];
const KINDS: MediaKind[] = ["image", "video", "audio", "other"];

/**
 * 查询串 → 清单筛选（三个入口共用：管理端 / 渠道商门户 / 客户端）。
 * ⚠ 只解析「产物维度」的参数；**归属范围（owners/userIds）由各入口自己补**——
 *   越权隔离绝不能交给客户端传的查询串决定。
 */
export function parseDownloadQuery(q: Record<string, string | undefined>): DownloadFilter {
	const num = (v?: string) => (v != null && v !== "" ? Number(v) : undefined);
	const list = <T extends string>(v: string | undefined, allow: readonly T[]): T[] | undefined => {
		if (!v) return undefined;
		const picked = v.split(",").map((s) => s.trim()).filter((s): s is T => (allow as readonly string[]).includes(s));
		return picked.length ? picked : undefined;
	};
	return {
		from: num(q.from),
		to: num(q.to),
		userName: q.user || undefined,
		purpose: q.purpose || undefined,
		model: q.model || undefined,
		storages: list(q.storages, STORAGES),
		kinds: list(q.kinds, KINDS),
		limit: num(q.limit),
	};
}

/** 供上层做「只要统计不要条目」的轻量调用（管理端 KPI 用） */
export function downloadManifestSummary(opts?: DownloadFilter): Omit<DownloadManifest, "items"> {
	const m = buildDownloadManifest({ ...opts, limit: MAX_ITEMS });
	const { items: _items, ...rest } = m;
	return rest;
}

export type { LogMeta };
