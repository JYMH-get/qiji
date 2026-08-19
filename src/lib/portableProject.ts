/**
 * portableProject —— 把项目数据改写成「可跨设备」形态（导出用）。
 *
 * 问题：项目里所有资产（图/视频/音频）引用的都是**本设备本地路径**——`asset://…`、
 * `http://asset.localhost/<绝对本地路径>`（convertFileSrc 产物）或原始文件路径。这些路径在另一台
 * 设备上不存在，直接把 .Qiji 拷过去只有一堆裂图。
 *
 * 解法（契合「id 是真理、url 是缓存」）：导出前把每个本地引用改写成 **公网 url**（assetBlobs 里
 * 登记的 OSS / 服务端 url），并把 assetBlobs 精简为可跨设备字段（id/url/mime/ext，丢掉本地路径）。
 * 接收设备加载后，显示层 useDisplayUri 见到公网 url 会自动 saveRemoteAsset 落到本机 assets 目录——
 * 图像/视频照常显示（前提：两台设备连同一个管理端，资产已上云 OSS）。
 */
import { isWebviewLocalUri } from "@/lib/publicUrl";
import type { QijiProject, AssetBlob, GenMeta } from "@/services/projectFile";

/**
 * 返回改写后的**深拷贝**（不动传入对象）+ unresolved：仍是纯本地、无公网 url 兜底的引用数
 * （换设备会缺图，供导出后提示用户）。
 */
export function toPortableProjectData(project: QijiProject): { data: QijiProject; unresolved: number } {
	const clone: QijiProject = structuredClone(project);
	const blobs = clone.assetBlobs || {};

	// 本地引用（localUri / localPath / srcUri）→ 公网 url 映射（url 须是非 webview 伪域的 http(s)）
	const uriToUrl = new Map<string, string>();
	for (const b of Object.values(blobs)) {
		const url = b.url;
		if (!url || isWebviewLocalUri(url)) continue;
		for (const key of [b.localUri, b.localPath, b.srcUri]) {
			if (key && key !== url) uriToUrl.set(key, url);
		}
	}

	// 深度改写所有字符串引用：命中映射的换成公网 url；仍是本地引用（asset:// / asset.localhost）且
	// 无 url 兜底的计入 unresolved（去重统计）。
	const unresolvedSet = new Set<string>();
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const mapped = uriToUrl.get(v);
			if (mapped) return mapped;
			if (isWebviewLocalUri(v) || /^asset:\/\//i.test(v)) unresolvedSet.add(v);
			return v;
		}
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) v[i] = walk(v[i]);
			return v;
		}
		if (v && typeof v === "object") {
			const o = v as Record<string, unknown>;
			for (const k of Object.keys(o)) o[k] = walk(o[k]);
			return v;
		}
		return v;
	};
	walk(clone);

	// genMeta 以「图片 uri」为键——generic walk 只改值不改键，这里把键也一并改写，
	// 否则换设备后引用变成 url、详情面板却按旧本地 uri 存 genMeta 而查不到。
	if (clone.genMeta) {
		const gm: Record<string, GenMeta> = {};
		for (const [k, v] of Object.entries(clone.genMeta)) gm[uriToUrl.get(k) ?? k] = v as GenMeta;
		clone.genMeta = gm;
	}

	// assetBlobs 只保留可跨设备字段（本地路径无意义、且会误导接收端把死路径当缓存）
	const portableBlobs: Record<string, AssetBlob> = {};
	for (const [id, b] of Object.entries(blobs)) {
		if (b.url && !isWebviewLocalUri(b.url)) portableBlobs[id] = { id: b.id, url: b.url, mime: b.mime, ext: b.ext };
	}
	clone.assetBlobs = portableBlobs;

	return { data: clone, unresolved: unresolvedSet.size };
}
