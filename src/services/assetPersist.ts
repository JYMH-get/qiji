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
import { isWebviewLocalUri } from "@/lib/publicUrl";
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
		// blob.url 绝不能记 webview 伪域直链（http://asset.localhost/...）——会被 ensurePublicUrl
		// 当缓存公网链发给上游（「发给火山 Invalid parameter」事故根源之一）；srcUri 仍记原 uri 供反查。
		const blob: AssetBlob = { id, url: /^https?:/.test(uri) && !isWebviewLocalUri(uri) ? uri : existing?.url, srcUri: uri, localPath: dest, localUri, ext, mime };
		useProjectStore.getState().registerAssetBlob(blob);
		return blob;
	} catch (e) {
		console.warn("[assetPersist] ensureLocalOriginal failed:", e);
		return existing ?? null;
	}
}

/**
 * 本地上传的素材（垫图/参考图）也落一份本地原件：把用户选中的 File 字节写到 <assets>/<id>.<ext>，
 * 登记三元映射（id / OSS url / 本地路径+可显示 uri）。返回 blob；非 Tauri 或失败返回 null。
 *
 * 目的：显示层改用 asset:// 本地 uri，而不是 base64 dataURL——base64 会被整段写进 project.Qiji
 * （genMeta/assetRefImages），是项目文件膨胀到百 MB、进而保存中断损坏的根源。
 * 字节直接来自 File（无需二次下载），比 ensureLocalOriginal(fetch data:) 更省。
 */
export async function saveUploadedLocal(file: Blob, id: string, url?: string, name?: string): Promise<AssetBlob | null> {
	if (!isTauri()) return null;
	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const mime = file.type || undefined;
		const ext = extOf(name || (file as File).name || "", mime);
		const dir = await projectAssetsDir();
		const { join } = await import("@tauri-apps/api/path");
		const dest = await join(dir, `${id}.${ext}`);
		const { writeFile } = await import("@tauri-apps/plugin-fs");
		await writeFile(dest, bytes);
		const { convertFileSrc } = await import("@tauri-apps/api/core");
		const localUri = convertFileSrc(dest);
		await registerWithServer(id, dest);
		// url 只记真公网链（不记 webview 伪域，防毒化 ensurePublicUrl 缓存，同 saveRemoteAsset）
		const blob: AssetBlob = {
			id,
			url: url && /^https?:/.test(url) && !isWebviewLocalUri(url) ? url : undefined,
			localPath: dest, localUri, ext, mime,
		};
		useProjectStore.getState().registerAssetBlob(blob);
		return blob;
	} catch (e) {
		console.warn("[assetPersist] saveUploadedLocal failed:", e);
		return null;
	}
}

/**
 * 原生下载（绕过 webview CORS）：调 Rust download_url 把远程 url 落成系统临时文件，
 * 返回临时路径 + content-type。命令不存在/失败/非 Tauri → 返回 null（调用方回退 webview fetch）。
 * timeoutSecs：单次下载超时秒数（缺省由 Rust 侧 180s 兜底）。
 */
async function nativeDownload(url: string, timeoutSecs?: number): Promise<{ path: string; contentType: string } | null> {
	if (!isTauri()) return null;
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		const r = await invoke<{ path: string; content_type: string }>("download_url", { url, timeoutSecs });
		return r?.path ? { path: r.path, contentType: r.content_type || "" } : null;
	} catch (e) {
		console.warn("[assetPersist] nativeDownload failed:", e);
		return null;
	}
}

/** 远程下载选项（第158轮）：服务端未转存的原始直链结果用 图3×30s / 视频2×120s 快重试 */
export interface RemoteFetchOpts {
	/** 下载尝试次数（缺省 1，保持既有行为——大视频/OSS 直链单次 180s 已够） */
	attempts?: number;
	/** 单次下载超时秒数（缺省 180） */
	timeoutSecs?: number;
}

/**
 * 下载远程资产到本地并登记。返回三元映射 blob；失败/非 Tauri 返回 null。
 * 优先走 Rust 原生下载（绕 webview CORS，任何公网直链可达）；失败回退 webview fetch。
 */
export async function saveRemoteAsset(assetId: string, url: string, opts?: RemoteFetchOpts): Promise<AssetBlob | null> {
	if (!isTauri() || !url || /^(data:|blob:)/.test(url)) return null;
	const attempts = Math.max(1, opts?.attempts ?? 1);
	try {
		const dir = await projectAssetsDir();
		const { join } = await import("@tauri-apps/api/path");
		const fs = await import("@tauri-apps/plugin-fs");
		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				let mime: string | undefined;
				let ext: string;
				let dest: string;
				const nd = await nativeDownload(url, opts?.timeoutSecs);
				if (nd) {
					mime = nd.contentType || undefined;
					ext = extOf(url, mime);
					dest = await join(dir, `${assetId}.${ext}`);
					await fs.copyFile(nd.path, dest);
					await fs.remove(nd.path).catch(() => {});
				} else {
					// 回退：webview fetch（受源站 CORS 约束，上游直链可能失败）
					const resp = await fetch(url, { signal: AbortSignal.timeout((opts?.timeoutSecs ?? 180) * 1000) });
					if (!resp.ok) throw new Error(`下载 HTTP ${resp.status}`);
					mime = resp.headers.get("content-type") || undefined;
					ext = extOf(url, mime);
					dest = await join(dir, `${assetId}.${ext}`);
					const bytes = new Uint8Array(await resp.arrayBuffer());
					await fs.writeFile(dest, bytes);
				}
				const { convertFileSrc } = await import("@tauri-apps/api/core");
				const localUri = convertFileSrc(dest);
				await registerWithServer(assetId, dest);
				// 缩略图（P1）：图片资产落地后顺手生成 256px WebP 传到 thumb/ 前缀。
				// 用刚落好的本地副本降采样（零额外下载）；全程 best-effort，失败不影响任何事。
				if (!mime || mime.startsWith("image/")) {
					void import("./thumbGen").then((m) => m.ensureThumb(assetId, { localPath: dest, uri: localUri }, mime)).catch(() => {});
				}
				// url 不记 webview 伪域直链（同 ensureLocalOriginal：进 url 会毒化 ensurePublicUrl 缓存）
				return { id: assetId, url: isWebviewLocalUri(url) ? undefined : url, localPath: dest, localUri, ext, mime };
			} catch (e) {
				if (attempt >= attempts) throw e;
				await new Promise((r) => setTimeout(r, 1000 * attempt));
			}
		}
		return null;
	} catch (e) {
		console.warn("[assetPersist] saveRemoteAsset failed:", e);
		return null;
	}
}

/** 按扩展名猜 mime（uploadBlobToOss 用；blob.mime 缺失时的兜底） */
function mimeOfExt(ext?: string): string {
	const m: Record<string, string> = {
		png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
		mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
		mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
	};
	return (ext && m[ext.toLowerCase()]) || "application/octet-stream";
}

/**
 * 把已落本地的结果字节经「素材上传」接口（POST /v1/assets）传回服务端落 OSS，
 * 返回把 id/url 替换为 OSS 台账记录的 blob（第158轮）。
 * 场景：服务端下载上游成片失败（服务器到成片托管域网络不通）→ 任务以原始时效直链完成
 * （meta.rehosted=false）→ 客户端本机网络下载成功后由这里补上「转存 OSS」的缺口——
 * 显示继续走本地副本，后续提交/垫图经三元映射拿到 OSS 永久直链（原始直链会过期）。
 * 上传失败返回原 blob（本地可显示；url 仍是时效直链，过期后凭本地副本仍可重传）。
 * taskId：来源任务 id——上传成功后回报服务端改写该任务响应体（原始直链→真 OSS 资产，
 * rehosted→true）：断连找回/重连原任务再取结果拿到永久直链，不再重复「下载+上传」；best-effort。
 */
export async function uploadBlobToOss(blob: AssetBlob, name?: string, prefix?: string, taskId?: string): Promise<AssetBlob> {
	if (!isTauri() || !blob.localPath) return blob;
	try {
		const fs = await import("@tauri-apps/plugin-fs");
		const bytes = await fs.readFile(blob.localPath);
		const mime = blob.mime || mimeOfExt(blob.ext);
		const file = new Blob([bytes as unknown as BlobPart], { type: mime });
		const filename = `${(name || blob.id).replace(/[\\/:*?"<>|]/g, "_")}.${blob.ext || "bin"}`;
		const { managedClient } = await import("@/services/managedClient");
		// 上传重试 2 次：客户端↔服务端链路一般是通的（刚轮询完任务拿到结果），偶发抖动补一次即可；
		// 两次都失败才放弃（返回原 blob——映射里暂留时效原链，本地副本在，过期后可经「检查素材」重传）
		let up: { id: string; url: string } | null = null;
		for (let attempt = 1; attempt <= 2 && !up; attempt++) {
			try {
				up = await managedClient.uploadAsset(file, filename, prefix);
			} catch (e) {
				if (attempt >= 2) throw e;
				await new Promise((r) => setTimeout(r, 1500));
			}
		}
		if (up?.id && up?.url) {
			// 本地文件改名为 OSS 台账 id（§12.2「文件名=id」惯例——下载时用的是 img-<taskId> 合成名）；
			// 改名失败沿用原文件名，三元映射（id↔url↔localPath）仍正确
			let localPath = blob.localPath;
			let localUri = blob.localUri;
			try {
				const { join, dirname } = await import("@tauri-apps/api/path");
				const dest = await join(await dirname(blob.localPath), `${up.id}.${blob.ext || "bin"}`);
				if (dest !== blob.localPath) {
					await fs.rename(blob.localPath, dest);
					localPath = dest;
					const { convertFileSrc } = await import("@tauri-apps/api/core");
					localUri = convertFileSrc(dest);
				}
			} catch { /* 改名失败：不影响映射正确性 */ }
			await registerWithServer(up.id, localPath);
			// 回报服务端改写任务响应体（best-effort：失败只影响断连找回时多走一次接力转存，映射已正确）
			if (taskId) await managedClient.rewriteTaskResult(taskId, up.id).catch(() => false);
			return { ...blob, id: up.id, url: up.url, localPath, localUri };
		}
	} catch (e) {
		console.warn("[assetPersist] uploadBlobToOss failed:", e);
	}
	return blob;
}
