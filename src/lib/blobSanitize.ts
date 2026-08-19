/**
 * blobSanitize —— 三元映射加载清洗（第145轮，纯函数）。
 *
 * `blob:` objectURL 是**会话级**显示 uri（上传落本地副本失败时的兜底，nodeUpload.ts）：
 * 随项目文件持久化后，重开必死——AssetPanel 缩略图/上传节点显示为空（用户报「本地素材经常丢失」根因之一）。
 * 项目加载时一律剥除持久化下来的 blob: localUri（本会话新建的尚未经过加载路径，不受影响），
 * 让 显示解析/上传去重（uploadMediaToCanvasAsset dedup）回落到 localPath/公网 url 再由自愈补本地副本。
 */
import type { AssetBlob } from "@/services/projectFile";

/** 剥除跨会话必死的 blob: localUri；无需改动时返回原对象（引用不变，省一次 setState） */
export function sanitizeAssetBlobs(blobs: Record<string, AssetBlob>): Record<string, AssetBlob> {
	let changed = false;
	const out: Record<string, AssetBlob> = {};
	for (const [k, b] of Object.entries(blobs)) {
		if (b && typeof b.localUri === "string" && b.localUri.startsWith("blob:")) {
			out[k] = { ...b, localUri: undefined };
			changed = true;
		} else {
			out[k] = b;
		}
	}
	return changed ? out : blobs;
}
