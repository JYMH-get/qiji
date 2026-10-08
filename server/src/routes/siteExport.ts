/** 官网预览和静态包导出，仅注册在管理员鉴权范围内。 */
import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import { buildWebsiteFiles, builtinWebsiteImages, renderWebsitePreview } from "../../../website/render.ts";
import { publicSiteConfig, SITE_IMAGE_SLOTS } from "../store/site.ts";

/** 后台内置图不再依赖业务服务的公开 /site-assets 路由。 */
export async function siteImageSlots() {
	const images = await builtinWebsiteImages();
	return Object.entries(SITE_IMAGE_SLOTS).map(([slot, image]) => ({
		slot, label: image.label, builtin: images[image.file],
	}));
}

export function registerSiteExportRoutes(api: FastifyInstance): void {
	api.get("/admin-api/site/preview", async (_req, reply) => {
		// 在任何异步文件读取前冻结配置，避免并发保存混入同一预览/导出。
		const snapshot = structuredClone(publicSiteConfig());
		reply.header("Cache-Control", "no-store");
		return { html: await renderWebsitePreview(snapshot) };
	});

	api.get("/admin-api/site/export", async (_req, reply) => {
		const snapshot = structuredClone(publicSiteConfig());
		const files = await buildWebsiteFiles(snapshot);
		const zip = new JSZip();
		for (const file of files) zip.file(file.path, file.data);
		const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
		return reply
			.header("Cache-Control", "no-store")
			.header("Content-Type", "application/zip")
			.header("Content-Disposition", 'attachment; filename="qiji-website.zip"')
			.send(archive);
	});
}
