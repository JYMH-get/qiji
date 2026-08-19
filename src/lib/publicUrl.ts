/**
 * publicUrl —— 把任意素材 uri 解析成「上游可达的真·公网 url」的**唯一实现**。
 *
 * 资产模式（Frame161195）与画布模式（pluginRegistry）共用这一份逻辑，杜绝两套操作：
 * 生成视频/图片时，所有垫图/素材都必须是公网直链，绝不能把本地直链发给上游。
 *
 *  - 已是真·公网 url（OSS 等）→ 直接用；
 *  - 本地素材（data:/blob:/asset.localhost/localhost 直链）→ 取字节上传管理端成临时资产(TP 前缀)，
 *    拿回公网 url，并按 srcUri 缓存三元映射（blobByUri）避免重复上传。
 */
import { useProjectStore } from "@/store/projectStore";
import { managedClient } from "@/services/managedClient";
import { healPublicUrlIfDead } from "@/services/assetHeal";

/**
 * 判断一个 uri 是否「上游可达的真·公网 url」。
 * 关键：Tauri convertFileSrc 在 Win/WebView2 下产出 `http://asset.localhost/<本地路径>`，
 * 它形式上是 http(s) 但只能本机访问——必须排除，否则软件资产垫图会把本地直链原样发给上游导致失败。
 * 同样排除管理端本地直链(localhost:8787 /raw)。这些都需先取字节上传 OSS 得到公网 url。
 */
/**
 * 判断 uri 是否「webview 本地伪域直链」（Tauri convertFileSrc 在 Win/WebView2 下产出
 * `http://asset.localhost/<本地路径>`）。它形式上是 http 但**本身就是本地文件的显示态**——
 * 显示层必须原样直用，绝不能当远程 url 走下载/换源（换成失效映射即「短暂显示后裂开」）。
 */
export function isWebviewLocalUri(uri: string): boolean {
	if (!/^https?:\/\//i.test(uri)) return false;
	try {
		return new URL(uri).hostname.toLowerCase().endsWith(".localhost");
	} catch {
		return false;
	}
}

export function isPublicUrl(uri: string): boolean {
	if (!/^https?:\/\//i.test(uri)) return false;
	try {
		const h = new URL(uri).hostname.toLowerCase();
		if (h === "localhost" || h === "127.0.0.1" || h === "::1") return false;
		if (h === "asset.localhost" || h === "tauri.localhost" || h.endsWith(".localhost")) return false;
		return true;
	} catch {
		return false;
	}
}

/**
 * 把任意素材 uri 解析成公网可达 url 供上游 fetch（简梦/喵视频参考图须公网 HTTPS）。
 * onUploading：上传开始/结束回调（供 UI 显示缩略图转圈，可选）。
 * 失败返回空串（调用方应跳过该素材）。
 */
export async function ensurePublicUrl(uri: string, opts?: { name?: string; onUploading?: (busy: boolean) => void }): Promise<string> {
	if (!uri) return "";
	// 真·公网 url（OSS 等）直通；但先经「死链自愈」——若该 OSS 对象已丢失且本机有本地副本，
	// 用本地字节重传写回原键修复后再发上游（否则死垫图直发上游 → 502/Invalid parameter）。
	// 自愈无需/无法时原样返回，且本会话确认活的资产不再重复探测（不拖慢每次提交）。
	if (isPublicUrl(uri)) return healPublicUrlIfDead(uri);
	// 缓存的 url 必须**再过一遍 isPublicUrl**：历史自愈曾把 asset.localhost 本地直链写进 blob.url/srcUri
	// （实测事故：图像超分把 http://asset.localhost/... 发给火山 → Invalid parameter）——毒映射一律不信，
	// 落到下方「取字节上传」兜底出真公网 url。
	const cached = useProjectStore.getState().blobByUri(uri)?.url;
	if (cached && isPublicUrl(cached)) return cached;
	opts?.onUploading?.(true);
	try {
		const resp = await fetch(uri); // data:/blob:/asset:///本地 http 均可 fetch
		if (!resp.ok) return "";
		const blob = await resp.blob();
		const ext = ((blob.type.split("/")[1] || "png").split(";")[0]).replace("jpeg", "jpg");
		const fname = `${(opts?.name || "素材").replace(/[\\/:*?"<>|]/g, "_")}.${ext}`;
		const res = await managedClient.uploadAsset(blob, fname, "TP"); // TP=temporary
		useProjectStore.getState().registerAssetBlob({ id: res.id, url: res.url, srcUri: uri });
		// 懒上传回填（第194轮）：源 uri 若对应本地暂存资产（LC-，无 url），把 OSS url 写回其映射——
		// 「此次拿到的链接可重复利用」：下次同素材 blobByUri(uri).url 直接命中，不再重复上传
		const src = useProjectStore.getState().blobByUri(uri);
		if (src && src.id !== res.id && !src.url) {
			useProjectStore.getState().registerAssetBlob({ ...src, url: res.url });
		}
		return res.url;
	} catch (e) {
		console.warn("[publicUrl] ensurePublicUrl failed:", e);
		return "";
	} finally {
		opts?.onUploading?.(false);
	}
}
