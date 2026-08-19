/**
 * 缩略图生成（P1）——把图片资产降采样成 256px WebP 直传到 OSS 的 `thumb/` 前缀。
 *
 * 为什么要：素材库/收藏墙一屏几十张图，直接引原图＝几十 MB 流量还慢（原图平均 3.2 MB）。
 * 缩略图约 10–20 KB，一屏几百 KB。
 *
 * 边界（有意为之）：
 *  - **只处理图片**（视频/音频没有可直接降采样的画面，要抽帧是另一件事）；
 *  - **不进 assets 台账**：缩略图是原图的附属品，没有独立资产 id、不占用户配额；
 *  - **全程 best-effort**：任一步失败静默跳过——没有缩略图一切照常，只是显示慢一点；
 *  - **同一 id 只尝试一次**（本会话内），失败不反复重试烧流量。
 */
import { managedClient } from "./managedClient";

const THUMB_MAX = 256;
/** 本会话已处理过的资产 id（成功或失败都记，不重复尝试） */
const attempted = new Set<string>();

/**
 * 把一张图缩到 <=256px 的 WebP。
 *
 * ⚠ **必须从字节走，不能直接把 `asset://` / `http://asset.localhost/...` 喂给 Image**：
 *   Tauri 的资产协议不返回 CORS 头 —— 加 `crossOrigin` 会加载失败，不加则 canvas 被污染、
 *   `toBlob` 当场抛 SecurityError。两条路都产不出缩略图（首版就是这么写的，线上 0 张）。
 *   改为读本地原件字节 → Blob → objectURL：同源、不污染，稳。
 */
async function downscaleToWebp(src: string | Blob): Promise<Blob | null> {
	let objectUrl = "";
	try {
		const url = typeof src === "string" ? src : (objectUrl = URL.createObjectURL(src));
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const el = new Image();
			el.onload = () => resolve(el);
			el.onerror = () => reject(new Error("图片加载失败"));
			el.src = url;
		});
		const scale = Math.min(1, THUMB_MAX / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
		if (!Number.isFinite(scale) || scale <= 0) return null;
		const w = Math.max(1, Math.round((img.naturalWidth || THUMB_MAX) * scale));
		const h = Math.max(1, Math.round((img.naturalHeight || THUMB_MAX) * scale));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0, w, h);
		return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/webp", 0.72));
	} catch {
		return null;
	} finally {
		if (objectUrl) URL.revokeObjectURL(objectUrl);
	}
}

/**
 * 为某个资产生成并上传缩略图。fire-and-forget 调用即可（返回值只供测试用）。
 * @param assetId    服务端资产 id
 * @param source     本地原件路径（Tauri，优先——读字节最稳）或可直接喂给 Image 的地址
 * @param contentType 资产 MIME —— 非图片直接跳过
 */
export async function ensureThumb(assetId: string, source: { localPath?: string; uri?: string }, contentType?: string): Promise<boolean> {
	if (!assetId || (!source.localPath && !source.uri)) return false;
	if (contentType && !contentType.startsWith("image/")) return false;
	if (attempted.has(assetId)) return false;
	attempted.add(assetId);

	let input: string | Blob | null = null;
	if (source.localPath) {
		// 首选：读本地原件字节（无 CORS、无 canvas 污染）
		try {
			const fs = await import("@tauri-apps/plugin-fs");
			const bytes = await fs.readFile(source.localPath);
			input = new Blob([bytes as unknown as BlobPart], { type: contentType || "image/png" });
		} catch {
			input = null; // 读不到就退回 uri（浏览器 dev 等无 Tauri 环境）
		}
	}
	if (!input && source.uri) input = source.uri;
	if (!input) return false;

	const blob = await downscaleToWebp(input);
	if (!blob || blob.size === 0) return false;
	return managedClient.uploadThumb(assetId, blob);
}

/** 测试/切换账号时重置「已尝试」记忆 */
export function resetThumbAttempts(): void {
	attempted.clear();
}
