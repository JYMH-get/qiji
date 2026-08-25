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

/** 历史 url 别名表上限：够覆盖「原键 → 桥接恢复 → 再迁桶」这类多跳，又不会无限增长 */
export const PAST_URLS_MAX = 8;

/**
 * 三元映射合并（registerAssetBlob 的**唯一实现**，纯函数可单测）。
 *
 * ⚠ 关键（第254轮，勿回退）：`url` 被换掉时必须把**旧 url 归档进 `pastUrls`**。
 * 项目里散落的是写入当时的 url 字符串（节点素材 / genMeta / assetRefImages），
 * url 一换（旧 OSS 桥接恢复 / 别人先恢复过 / reput 落到新键），这些旧 uri 就再也
 * 反查不回本 blob —— 自愈永远命中不了、提交仍发旧死链（用户实报「检查完仍然使用过期链接」）。
 *
 * 归档规则：去重、不含当前 url、最新的排前、上限 PAST_URLS_MAX。
 */
export function mergeAssetBlob(prev: AssetBlob | undefined, next: AssetBlob): AssetBlob {
	const merged: AssetBlob = { ...prev, ...next };
	const oldUrl = prev?.url;
	// 只在「本来有 url」且「确实换成了另一个 url」时归档（清空 url 不算换链，不归档）
	if (oldUrl && merged.url && merged.url !== oldUrl) {
		const kept = [oldUrl, ...(prev?.pastUrls ?? []), ...(next.pastUrls ?? [])];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const u of kept) {
			if (!u || u === merged.url || seen.has(u)) continue;
			seen.add(u);
			out.push(u);
			if (out.length >= PAST_URLS_MAX) break;
		}
		merged.pastUrls = out;
	}
	return merged;
}

/** 该 blob 是否能由这个 uri 反查到（当前 url / 本地显示 uri / 原始来源 uri / 历史 url 别名） */
export function blobMatchesUri(b: AssetBlob, uri: string): boolean {
	return b.localUri === uri || b.url === uri || b.srcUri === uri || !!b.pastUrls?.includes(uri);
}
