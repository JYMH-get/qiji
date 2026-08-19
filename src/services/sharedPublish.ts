/**
 * sharedPublish —— 「添加到共享资产」的条目解析（三处右键入口共用）。
 *
 * 分享=登记 OSS 记录（第120轮语义，字节绝不复制）：条目优先带台账 assetId（id 是真理，
 * 服务端按台账取当前直链），否则须有真公网 url；两者都没有的素材（纯本地未入库）解析为 null 跳过。
 */
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { getPlugin } from "@/nodes/pluginRegistry";

export interface SharedShareItem {
	assetId?: string;
	url?: string;
	name: string;
	mime?: string;
}

/** 由显示 uri 解析可登记条目（经 blob 三元映射拿台账 id/公网 url）；无 OSS 记录返回 null。 */
export function sharedItemFromUri(uri: string | undefined, name: string, mime?: string): SharedShareItem | null {
	if (!uri) return null;
	const blob = useProjectStore.getState().blobByUri(uri);
	if (!blob?.id && !blob?.url) return null;
	return { assetId: blob.id, url: blob.url, name: name || "素材", mime: mime || blob.mime };
}

/** 画布节点（可多选）：每个节点取其结果资产（主图/主视频）。返回可登记条目 + 跳过数（无结果/无 OSS 记录）。 */
export function nodeSharedItems(nodeIds: string[]): { items: SharedShareItem[]; skipped: number } {
	const nodes = useCanvasStore.getState().nodes;
	const assets = useLibraryStore.getState().assets;
	const items: SharedShareItem[] = [];
	let skipped = 0;
	for (const id of nodeIds) {
		const node = nodes[id];
		const asset = node?.data.resultAssetId ? assets[node.data.resultAssetId] : null;
		if (!node || !asset?.uri) {
			skipped++;
			continue;
		}
		const name = asset.name || (typeof node.data.title === "string" && node.data.title) || getPlugin(node.type)?.label || "素材";
		const mime = asset.kind === "video" ? "video/mp4" : asset.kind === "audio" ? "audio/mpeg" : asset.kind === "image" ? "image/png" : undefined;
		// 库资产的 serverAssetId 即台账 id：blob 三元映射优先，回退 serverAssetId（服务端凭 id 取直链）
		const it = sharedItemFromUri(asset.uri, name, mime)
			?? (asset.serverAssetId ? { assetId: asset.serverAssetId, name, mime } : null);
		if (it) items.push(it);
		else skipped++;
	}
	return { items, skipped };
}
