/**
 * 官网站点（第244轮）：对外宣传主站，独立于 /admin /agent /v1。
 *  GET /               → 官网页面（src/www/index.html，服务时注入 data/site.json 配置）
 *  GET /site-assets/*  → 随包内置的初始图片（被管理端替换过的槽位走 OSS 直链，不经这里）
 *
 * 内容管理走管理端「网页管理」页（/admin-api/site*，见 routes/admin.ts）。
 * relay 渠道节点不注册本路由（官网属源站；见 index.ts）。
 */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { getSiteConfig, publicSiteConfig } from "../store/site.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WWW_DIR = join(here, "..", "www");
const SITE_HTML = join(WWW_DIR, "index.html");
const ASSETS_DIR = join(WWW_DIR, "assets");

const CONTENT_TYPES: Record<string, string> = {
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".ico": "image/x-icon",
};

// 站点开关关闭时的占位页（刻意不 404——避免运维误判服务挂了）
const CLOSED_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Qiji 漫剧</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#161826;color:#e9e9ed;font-family:system-ui,sans-serif">
<div style="text-align:center"><div style="font-size:22px;letter-spacing:0.2em">Qiji 漫剧</div><div style="margin-top:10px;font-size:13px;opacity:0.55">官网维护中，稍后再来</div></div>
</body></html>`;

export async function registerSiteRoutes(app: FastifyInstance): Promise<void> {
	app.get("/", async (_req, reply) => {
		reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-cache");
		if (!getSiteConfig().enabled) return reply.send(CLOSED_HTML);
		// 每请求现读 + 注入配置（与 /admin 同模式；文件小，改配置/改页面即生效无需重启）。
		// JSON 里的 "<" 转义成 <，防配置文本含 </script> 提前闭合脚本标签。
		const cfg = JSON.stringify(publicSiteConfig()).replace(/</g, "\\u003c");
		const html = readFileSync(SITE_HTML, "utf8").replace('"__SITE_CONFIG__"', cfg);
		return reply.send(html);
	});

	app.get("/site-assets/:name", async (req, reply) => {
		const name = (req.params as { name: string }).name || "";
		// 白名单字符 + 显式扩展名映射，杜绝目录穿越
		if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) {
			return reply.code(404).send({ error: { message: "not found" } });
		}
		const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
		const type = CONTENT_TYPES[ext];
		if (!type) return reply.code(404).send({ error: { message: "not found" } });
		const file = join(ASSETS_DIR, name);
		try {
			const st = statSync(file);
			const etag = `"${st.size}-${Math.floor(st.mtimeMs)}"`;
			if (req.headers["if-none-match"] === etag) return reply.code(304).send();
			return reply
				.header("Content-Type", type)
				.header("Cache-Control", "public, max-age=3600")
				.header("ETag", etag)
				.send(readFileSync(file));
		} catch {
			return reply.code(404).send({ error: { message: "not found" } });
		}
	});
}
