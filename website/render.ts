/**
 * 独立官网构建。只读取本目录下的模板和固定图片，不加载业务 store、不访问网络、不写文件。
 * 输入可来自 publicSiteConfig() 或完整 site.json；每次渲染重新投影公开字段。
 */
import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

export interface WebsiteAnnouncement {
	id: string;
	title: string;
	body: string;
	date: string;
	/** 原始 site.json 中可含此字段；false 的公告不会进入任何导出文件。 */
	enabled?: boolean;
}

export interface WebsiteRelease {
	version: string;
	date: string;
	title: string;
	items: string[];
}

/** 与服务端公开配置兼容；运行时仍对白名单、类型和 URL 协议进行校验。 */
export interface WebsiteConfig {
	enabled: boolean;
	version: string;
	sizeNote: string;
	downloadUrl: string;
	backupUrl: string;
	contacts: { bd: string; support: string; wechat: string; qq: string };
	icp: string;
	showStats: boolean;
	showChannels: boolean;
	images: Record<string, string>;
	announcements: WebsiteAnnouncement[];
	releases: WebsiteRelease[];
}

export interface WebsiteFile {
	/** ZIP 和静态站根目录下的相对 POSIX 路径；仅 index.html、site-assets/<固定文件名>。 */
	path: string;
	data: Buffer;
}

/** 与网页管理的 SITE_IMAGE_SLOTS 对应，禁止枚举任意目录或导出用户提供的文件路径。 */
export const WEBSITE_IMAGE_FILES: Readonly<Record<string, string>> = Object.freeze({
	"logo-full": "logo-full.svg",
	"app-icon": "app-icon.png",
	"cover-1": "cover-1.webp",
	"cover-2": "cover-2.webp",
	"cover-3": "cover-3.webp",
	"cover-4": "cover-4.webp",
	"shot-assets": "shot-assets.webp",
	"shot-canvas": "shot-canvas.webp",
	"shot-editor-1": "shot-editor-1.webp",
	"shot-editor-2": "shot-editor-2.webp",
	"shot-storyboard": "shot-storyboard.webp",
});

const MIME_TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", webp: "image/webp" };
const TEMPLATE_URL = new URL("./template/index.html", import.meta.url);

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : {};
}

function string(value: unknown, max: number): string {
	return typeof value === "string" ? value.slice(0, max) : "";
}

function publicUrl(value: unknown): string {
	const candidate = string(value, 1000).trim();
	if (!candidate) return "";
	try {
		const url = new URL(candidate);
		if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return candidate;
	} catch { /* 缺失或不安全的链接按未配置处理。 */ }
	return "";
}

/** 不通过展开运算复制输入，防止未来新增的管理端字段进入公开 HTML。 */
function publicConfig(input: unknown): WebsiteConfig {
	const raw = record(input);
	const contacts = record(raw.contacts);
	const rawImages = record(raw.images);
	const images: Record<string, string> = {};
	for (const slot of Object.keys(WEBSITE_IMAGE_FILES)) {
		const url = publicUrl(rawImages[slot]);
		if (url) images[slot] = url;
	}
	const announcements = (Array.isArray(raw.announcements) ? raw.announcements : [])
		.slice(0, 50).map(record).filter((item) => item.enabled !== false)
		.map((item) => ({ id: string(item.id, 40), title: string(item.title, 120), body: string(item.body, 4000), date: string(item.date, 40) }))
		.filter((item) => item.title);
	const releases = (Array.isArray(raw.releases) ? raw.releases : []).slice(0, 100).map(record)
		.map((item) => ({
			version: string(item.version, 40), date: string(item.date, 40), title: string(item.title, 120),
			items: (Array.isArray(item.items) ? item.items : []).slice(0, 20).map((value) => string(value, 300)).filter(Boolean),
		})).filter((item) => item.version || item.title);
	return {
		enabled: raw.enabled !== false,
		version: string(raw.version, 40), sizeNote: string(raw.sizeNote, 120),
		downloadUrl: publicUrl(raw.downloadUrl), backupUrl: publicUrl(raw.backupUrl),
		contacts: { bd: string(contacts.bd, 120), support: string(contacts.support, 120), wechat: string(contacts.wechat, 120), qq: string(contacts.qq, 120) },
		icp: string(raw.icp, 120).trim(), showStats: raw.showStats !== false, showChannels: raw.showChannels !== false,
		images, announcements, releases,
	};
}

function scriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function htmlText(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function maintenanceHtml(config: WebsiteConfig): string {
	const icp = config.icp ? `<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" style="color:inherit">${htmlText(config.icp)}</a>` : "";
	return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Qiji 漫剧</title></head>
<body style="margin:0;min-height:100vh;display:flex;flex-direction:column;background:#161826;color:#e9e9ed;font-family:system-ui,sans-serif">
<main style="flex:1;display:grid;place-items:center;text-align:center"><div><h1 style="font-size:22px;font-weight:500;letter-spacing:0.2em">Qiji 漫剧</h1><p style="font-size:13px;opacity:0.55">官网维护中，稍后再来</p></div></main>
<footer style="padding:24px;text-align:center;font-size:12px;opacity:0.65">© ${new Date().getFullYear()} Qiji 漫剧${icp ? " · " + icp : ""}</footer>
</body></html>`;
}

async function assetFiles(): Promise<WebsiteFile[]> {
	return Promise.all(Object.values(WEBSITE_IMAGE_FILES).map(async (name) => ({
		path: `site-assets/${name}`,
		data: await readFile(new URL(`./template/assets/${name}`, import.meta.url)),
	})));
}

async function render(config: WebsiteConfig, builtin: Record<string, string>): Promise<string> {
	if (!config.enabled) return maintenanceHtml(config);
	const template = await readFile(TEMPLATE_URL, "utf8");
	// 必须用 callback：配置里的 $&、$' 等文字不能成为 replace 的替换指令。
	return template.replace(/"__(SITE_CONFIG|WEBSITE_BUILTIN_URLS)__"/g, (_match, key: string) =>
		scriptJson(key === "SITE_CONFIG" ? config : builtin));
}

/**
 * 返回独立静态站的全部公开文件，调用方负责写目录或生成 ZIP。
 * 不包含原始 site.json、模板源码、业务数据、环境配置；远程图片和下载链接保留为显式 URL，构建不抓取。
 */
export async function buildWebsiteFiles(config: WebsiteConfig): Promise<WebsiteFile[]> {
	const projected = publicConfig(config);
	const builtin = Object.fromEntries(Object.entries(WEBSITE_IMAGE_FILES).map(([slot, name]) => [slot, `site-assets/${name}`]));
	const [html, assets] = await Promise.all([render(projected, builtin), assetFiles()]);
	return [{ path: "index.html", data: Buffer.from(html, "utf8") }, ...assets];
}

/** 内置文件名 → data URI，供已认证的网页管理返回图片列表；无相对服务端图片地址。 */
export async function builtinWebsiteImages(): Promise<Record<string, string>> {
	const files = await assetFiles();
	return Object.fromEntries(files.map(({ path, data }) => {
		const name = path.slice("site-assets/".length);
		const extension = name.slice(name.lastIndexOf(".") + 1);
		return [name, `data:${MIME_TYPES[extension]};base64,${data.toString("base64")}`];
	}));
}

/**
 * 完整 HTML 预览，所有内置图片（含 favicon、动态作品墙、远程图片失败回退）均内联。
 * 在独立浏览器/Blob URL 可直接打开；管理员配置的公开 OSS 图片仍使用原始 URL。
 */
export async function renderWebsitePreview(config: WebsiteConfig): Promise<string> {
	const projected = publicConfig(config);
	if (!projected.enabled) return maintenanceHtml(projected);
	const images = await builtinWebsiteImages();
	const builtin = Object.fromEntries(Object.entries(WEBSITE_IMAGE_FILES).map(([slot, name]) => [slot, images[name]]));
	return render(projected, builtin);
}
