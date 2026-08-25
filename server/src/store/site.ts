/**
 * 官网站点配置（第244轮）：官网页面 GET / 的唯一内容数据源，落盘 data/site.json。
 * 管理端「网页管理」页维护：站点开关、下载链接/安装包、联系方式、备案号、公告、更新记录、
 * 图片资产替换（原图存 OSS `site/img/` 前缀，未替换=用随包内置图 /site-assets/*）。
 *
 * ⚠ 本配置全量经官网页面公开下发——任何字段都不得存放密钥/内部信息。
 */
import { loadJson, saveJson } from "./db.ts";

const FILE = "site.json";

/** 官网公告（顶部公告栏 + 弹层列表） */
export interface SiteAnnouncement {
	id: string;
	title: string;
	body: string;
	/** 展示日期（自由文本，如 2026-08-21） */
	date: string;
	enabled: boolean;
}

/** 更新记录条目（官网「更新记录」页） */
export interface SiteRelease {
	version: string;
	date: string;
	title: string;
	items: string[];
}

/** 可替换图片槽位（key）→ 内置文件名（/site-assets/ 下随包分发的初始图） */
export const SITE_IMAGE_SLOTS: Record<string, { file: string; label: string }> = {
	"logo-full": { file: "logo-full.svg", label: "横版 Logo（导航/页脚/开场）" },
	"app-icon": { file: "app-icon.png", label: "应用图标（下载卡/favicon）" },
	"cover-1": { file: "cover-1.webp", label: "作品墙封面 1" },
	"cover-2": { file: "cover-2.webp", label: "作品墙封面 2" },
	"cover-3": { file: "cover-3.webp", label: "作品墙封面 3" },
	"cover-4": { file: "cover-4.webp", label: "作品墙封面 4" },
	"shot-assets": { file: "shot-assets.webp", label: "截图 · 资产模式" },
	"shot-canvas": { file: "shot-canvas.webp", label: "截图 · 画布模式" },
	"shot-editor-1": { file: "shot-editor-1.webp", label: "截图 · 实时剪辑 1" },
	"shot-editor-2": { file: "shot-editor-2.webp", label: "截图 · 实时剪辑 2" },
	"shot-storyboard": { file: "shot-storyboard.webp", label: "截图 · 分镜界面" },
};

export interface SiteConfig {
	/** 站点开关：关=GET / 返回简单占位页（不 404，避免误判服务挂了） */
	enabled: boolean;
	/** 客户端当前版本号（下载卡展示） */
	version: string;
	/** 体积/系统说明行（下载卡展示，自由文本） */
	sizeNote: string;
	/** 安装包直链（管理端直传 OSS 后自动回填；也可手填外链） */
	downloadUrl: string;
	/** 备用下载（网盘等） */
	backupUrl: string;
	/** 联系方式（空=官网隐藏该项） */
	contacts: { bd: string; support: string; wechat: string; qq: string };
	/** 备案号（空=官网不显示） */
	icp: string;
	/** 首页统计条 / 功能页渠道聚合区 开关（对应设计稿 props） */
	showStats: boolean;
	showChannels: boolean;
	/** 图片槽位覆盖：slot → OSS 原图 url；无键=用内置图 */
	images: Record<string, string>;
	announcements: SiteAnnouncement[];
	releases: SiteRelease[];
}

/** 出厂默认（与设计稿一致；releases 为示例数据，上线前在管理端替换成真实记录） */
function defaults(): SiteConfig {
	return {
		enabled: true,
		version: "1.0.0",
		sizeNote: "约 320 MB · Windows 10 / 11 (64-bit)",
		downloadUrl: "",
		backupUrl: "",
		contacts: { bd: "", support: "", wechat: "", qq: "" },
		icp: "",
		showStats: true,
		showChannels: true,
		images: {},
		announcements: [],
		releases: [
			{ version: "v1.0.0", date: "2026-08-12", title: "正式版发布", items: ["资产 / 画布 / 实时剪辑三大模式全部开放", "剧本推理支持整集自动拆分与五类资产提取", "时间轴支持一键导出剪映草稿"] },
			{ version: "v0.9.4", date: "2026-07-21", title: "画布模式增强", items: ["新增 720° 全景与 3D 导演台节点", "转深度图改为本地推理，不再消耗积分", "节点流式裂变支持批量连线"] },
			{ version: "v0.9.0", date: "2026-06-30", title: "实时剪辑上线", items: ["多轨时间轴与分镜自动占位入轨", "成片回填原位替换", "一键导出剪映草稿"] },
		],
	};
}

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const bool = (v: unknown, dft: boolean): boolean => (typeof v === "boolean" ? v : dft);

function sanitize(raw: Partial<SiteConfig> | undefined, base: SiteConfig): SiteConfig {
	const r = raw ?? {};
	const out: SiteConfig = {
		enabled: bool(r.enabled, base.enabled),
		version: r.version !== undefined ? str(r.version, 40) : base.version,
		sizeNote: r.sizeNote !== undefined ? str(r.sizeNote, 120) : base.sizeNote,
		downloadUrl: r.downloadUrl !== undefined ? str(r.downloadUrl, 1000) : base.downloadUrl,
		backupUrl: r.backupUrl !== undefined ? str(r.backupUrl, 1000) : base.backupUrl,
		contacts: r.contacts !== undefined
			? { bd: str(r.contacts?.bd, 120), support: str(r.contacts?.support, 120), wechat: str(r.contacts?.wechat, 120), qq: str(r.contacts?.qq, 120) }
			: base.contacts,
		icp: r.icp !== undefined ? str(r.icp, 120) : base.icp,
		showStats: bool(r.showStats, base.showStats),
		showChannels: bool(r.showChannels, base.showChannels),
		images: r.images !== undefined ? sanitizeImages(r.images) : base.images,
		announcements: r.announcements !== undefined ? sanitizeAnnouncements(r.announcements) : base.announcements,
		releases: r.releases !== undefined ? sanitizeReleases(r.releases) : base.releases,
	};
	return out;
}

function sanitizeImages(v: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (v && typeof v === "object") {
		for (const [k, url] of Object.entries(v as Record<string, unknown>)) {
			if (SITE_IMAGE_SLOTS[k] && typeof url === "string" && url) out[k] = url.slice(0, 1000);
		}
	}
	return out;
}

function sanitizeAnnouncements(v: unknown): SiteAnnouncement[] {
	if (!Array.isArray(v)) return [];
	return v.slice(0, 50).map((a, i) => ({
		id: str((a as SiteAnnouncement)?.id, 40) || `an-${Date.now()}-${i}`,
		title: str((a as SiteAnnouncement)?.title, 120),
		body: str((a as SiteAnnouncement)?.body, 4000),
		date: str((a as SiteAnnouncement)?.date, 40),
		enabled: bool((a as SiteAnnouncement)?.enabled, true),
	})).filter((a) => a.title);
}

function sanitizeReleases(v: unknown): SiteRelease[] {
	if (!Array.isArray(v)) return [];
	return v.slice(0, 100).map((r) => ({
		version: str((r as SiteRelease)?.version, 40),
		date: str((r as SiteRelease)?.date, 40),
		title: str((r as SiteRelease)?.title, 120),
		items: Array.isArray((r as SiteRelease)?.items) ? (r as SiteRelease).items.slice(0, 20).map((s) => str(s, 300)).filter(Boolean) : [],
	})).filter((r) => r.version || r.title);
}

let siteConfig: SiteConfig = sanitize(loadJson<Partial<SiteConfig>>(FILE, {}), defaults());

export function getSiteConfig(): SiteConfig {
	return siteConfig;
}

export function updateSiteConfig(patch: Partial<SiteConfig>): SiteConfig {
	siteConfig = sanitize(patch, siteConfig);
	saveJson(FILE, siteConfig);
	return siteConfig;
}

/** 设置/清除单个图片槽位覆盖（url 空=恢复内置图） */
export function setSiteImage(slot: string, url: string | null): SiteConfig {
	if (!SITE_IMAGE_SLOTS[slot]) return siteConfig;
	const images = { ...siteConfig.images };
	if (url) images[slot] = url.slice(0, 1000);
	else delete images[slot];
	return updateSiteConfig({ images });
}

/** 官网页面注入用的公开配置（剥掉停用的公告；其余字段本就全公开） */
export function publicSiteConfig(): Omit<SiteConfig, "announcements"> & { announcements: Omit<SiteAnnouncement, "enabled">[] } {
	const { announcements, ...rest } = siteConfig;
	return {
		...rest,
		announcements: announcements.filter((a) => a.enabled).map(({ enabled: _e, ...a }) => a),
	};
}
