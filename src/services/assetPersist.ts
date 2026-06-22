/**
 * assetPersist —— 生成资产的本地落盘 + 三元映射（assetId ↔ 公网url ↔ 本地路径）。
 *
 * 生成成功后把上游返回的 url 字节下载到 <项目文件夹>/assets/<assetId>.<ext>，
 * 返回 AssetBlob（id/url/localPath/localUri）。本地原件用于：①项目秒级加载（界面走 localUri）；
 * ②软件内按 id 快速垫图；③拖出软件外复制（经 Rust 本地 HTTP 服务 /a/<id> 提供原件）。
 *
 * 仅 Tauri 环境生效；浏览器/失败时返回 null（调用方退回直接用 url）。
 */
import { useProjectStore } from "@/store/projectStore";
import type { AssetBlob } from "@/services/projectFile";

function isTauri(): boolean {
	return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

/** 本地资产 HTTP 服务基址（Rust 提供，127.0.0.1:<随机端口>）；非 Tauri 为空 */
let _baseCache: string | null = null;
export async function assetHttpBase(): Promise<string> {
	if (_baseCache !== null) return _baseCache;
	if (!isTauri()) { _baseCache = ""; return ""; }
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		_baseCache = (await invoke<string>("asset_http_base")) || "";
	} catch {
		_baseCache = "";
	}
	return _baseCache;
}

/** 向 Rust 本地服务登记 id→本地路径，供拖出软件外按 /a/<id> 取原件 */
async function registerWithServer(id: string, path: string): Promise<void> {
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("register_asset", { id, path });
	} catch {
		/* 服务未起/非 Tauri：忽略 */
	}
}

function extOf(url: string, mime?: string): string {
	const m = url.split(/[?#]/)[0].match(/\.([a-zA-Z0-9]{2,5})$/);
	if (m) return m[1].toLowerCase();
	if (mime?.startsWith("image/")) return mime.slice(6).replace("jpeg", "jpg");
	if (mime?.startsWith("video/")) return mime.slice(6);
	if (mime?.startsWith("audio/")) return mime.slice(6);
	return "png";
}

/** 取（必要时创建）当前项目的 assets 目录 */
async function projectAssetsDir(): Promise<string> {
	const st = useProjectStore.getState();
	let savePath = st.savePath;
	if (!savePath) savePath = await st.ensureProjectPath();
	const { join, dirname } = await import("@tauri-apps/api/path");
	const folder = await dirname(savePath);
	const assets = await join(folder, "assets");
	const { exists, mkdir } = await import("@tauri-apps/plugin-fs");
	if (!(await exists(assets))) await mkdir(assets, { recursive: true });
	return assets;
}

/**
 * 把图片字节降采样为小预览 PNG（最长边 maxSide），返回 Uint8Array；失败返回 null。
 * 用「同源字节」走 createImageBitmap → canvas，避免 asset:// 图片污染画布导致 toBlob 抛错（拖影回退原图变巨大）。
 */
async function makeThumbBytes(bytes: Uint8Array, mime?: string, maxSide = 96): Promise<Uint8Array | null> {
	try {
		const srcBlob = new Blob([bytes as unknown as BlobPart], { type: mime || "image/png" });
		const bmp = await createImageBitmap(srcBlob);
		const w = bmp.width, h = bmp.height;
		if (!w || !h) { bmp.close?.(); return null; }
		const scale = Math.min(1, maxSide / Math.max(w, h));
		const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
		const canvas = document.createElement("canvas");
		canvas.width = cw; canvas.height = ch;
		const ctx = canvas.getContext("2d");
		if (!ctx) { bmp.close?.(); return null; }
		ctx.drawImage(bmp, 0, 0, cw, ch);
		bmp.close?.();
		const out: Blob | null = await new Promise((res) => canvas.toBlob(res, "image/png"));
		if (!out) return null;
		return new Uint8Array(await out.arrayBuffer());
	} catch {
		return null;
	}
}

/**
 * 确保资产有一张小预览图供「拖出软件外」做拖影（否则插件用原图，巨大）。
 * 优先用已登记的 thumbPath；否则按 localUri 降采样落盘 <id>.thumb.png，登记后返回路径。
 * 返回缩略图本地路径；不可用时回退原图 localPath（至少能拖出，只是大）。
 */
export async function ensureDragThumb(blob: AssetBlob): Promise<string | undefined> {
	if (!isTauri()) return blob.thumbPath || blob.localPath;
	if (blob.thumbPath) {
		try {
			const { exists } = await import("@tauri-apps/plugin-fs");
			if (await exists(blob.thumbPath)) return blob.thumbPath;
		} catch { /* 重新生成 */ }
	}
	if (!blob.localPath) return blob.localPath;
	try {
		const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
		const srcBytes = await readFile(blob.localPath); // 读原件字节（同源），避免 asset:// 污染画布
		const bytes = await makeThumbBytes(srcBytes, blob.mime);
		if (!bytes) return blob.localPath;
		const dir = await projectAssetsDir();
		const { join } = await import("@tauri-apps/api/path");
		const dest = await join(dir, `${blob.id}.thumb.png`);
		await writeFile(dest, bytes);
		useProjectStore.getState().registerAssetBlob({ ...blob, thumbPath: dest });
		return dest;
	} catch (e) {
		console.warn("[assetPersist] ensureDragThumb failed:", e);
		return blob.localPath;
	}
}

/** 由 uri 派生稳定 id（同一图重复落盘复用同一文件，避免堆积）*/
function deriveId(uri: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < uri.length; i++) { h ^= uri.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return "bk" + (h >>> 0).toString(36);
}

/**
 * 确保任意资产都有「本地原件」（localPath），供拖出软件外复制原图 / 软件内按文件名解析回 id。
 * 已有 localPath 直接返回；否则把 uri（http(s) / data: / blob: 均可 fetch）落盘到 <id>.<ext>、
 * 登记三元映射并向 Rust 服务注册。非 Tauri 或失败返回已有 blob / null（不影响 HTML5 软件内拖拽）。
 */
export async function ensureLocalOriginal(uri: string, opts?: { hintId?: string; name?: string }): Promise<AssetBlob | null> {
	if (!uri) return null;
	const existing = useProjectStore.getState().blobByUri(uri);
	if (existing?.localPath) return existing;
	if (!isTauri()) return existing ?? null;
	try {
		const resp = await fetch(uri); // fetch 同时支持 http(s)/data:/blob:
		if (!resp.ok) return existing ?? null;
		const mime = resp.headers.get("content-type") || undefined;
		const bytes = new Uint8Array(await resp.arrayBuffer());
		const ext = extOf(uri, mime);
		const id = existing?.id || opts?.hintId || deriveId(uri);
		const dir = await projectAssetsDir();
		const { join } = await import("@tauri-apps/api/path");
		const dest = await join(dir, `${id}.${ext}`);
		const { writeFile } = await import("@tauri-apps/plugin-fs");
		await writeFile(dest, bytes);
		const { convertFileSrc } = await import("@tauri-apps/api/core");
		const localUri = convertFileSrc(dest);
		await registerWithServer(id, dest);
		const blob: AssetBlob = { id, url: /^https?:/.test(uri) ? uri : existing?.url, srcUri: uri, localPath: dest, localUri, ext, mime };
		useProjectStore.getState().registerAssetBlob(blob);
		return blob;
	} catch (e) {
		console.warn("[assetPersist] ensureLocalOriginal failed:", e);
		return existing ?? null;
	}
}

/**
 * 下载远程资产到本地并登记。返回三元映射 blob；失败/非 Tauri 返回 null。
 */
export async function saveRemoteAsset(assetId: string, url: string): Promise<AssetBlob | null> {
	if (!isTauri() || !url || /^(data:|blob:)/.test(url)) return null;
	try {
		const resp = await fetch(url);
		if (!resp.ok) return null;
		const mime = resp.headers.get("content-type") || undefined;
		const bytes = new Uint8Array(await resp.arrayBuffer());
		const ext = extOf(url, mime);
		const dir = await projectAssetsDir();
		const { join } = await import("@tauri-apps/api/path");
		const dest = await join(dir, `${assetId}.${ext}`);
		const { writeFile } = await import("@tauri-apps/plugin-fs");
		await writeFile(dest, bytes);
		const { convertFileSrc } = await import("@tauri-apps/api/core");
		const localUri = convertFileSrc(dest);
		await registerWithServer(assetId, dest);
		return { id: assetId, url, localPath: dest, localUri, ext, mime };
	} catch (e) {
		console.warn("[assetPersist] saveRemoteAsset failed:", e);
		return null;
	}
}
