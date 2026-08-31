/**
 * projectAssetHeal —— 三元映射的「本地缺失 → OSS 下载恢复」方向。
 *
 * id 是真理，url 是缓存：先校验 localPath，缺失则用 blob.url 下载；缓存链接失效时再凭 id
 * 向服务端解析最新 url。恢复后仍登记到同一个 assetId，并把项目里持久化的旧本地 uri/旧 url
 * 改写为新的 localUri，兼容尚未接 useDisplayUri 的老显示点（尤其导入 .Qiji 后的分镜/资产页）。
 */
import type { AssetBlob } from "@/services/projectFile";
import { saveRemoteAsset } from "@/services/assetPersist";
import { managedClient } from "@/services/managedClient";
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { useCommitStore } from "@/store/commitStore";
import { isWebviewLocalUri } from "@/lib/publicUrl";

const isTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export interface AssetRestoreDeps {
	fileExists: (path: string) => Promise<boolean>;
	toDisplayUri: (path: string) => Promise<string>;
	download: (id: string, url: string) => Promise<AssetBlob | null>;
	resolveUrl: (id: string) => Promise<string>;
	register: (blob: AssetBlob) => void;
}

/** 单条映射恢复（依赖可注入，单测不依赖 Tauri）。 */
export async function restoreAssetBlob(blob: AssetBlob, deps: AssetRestoreDeps): Promise<AssetBlob | null> {
	if (blob.localPath) {
		try {
			if (await deps.fileExists(blob.localPath)) {
				const localUri = await deps.toDisplayUri(blob.localPath);
				if (localUri !== blob.localUri) deps.register({ id: blob.id, localPath: blob.localPath, localUri });
				return localUri === blob.localUri ? blob : { ...blob, localUri };
			}
		} catch {
			// 文件系统/convertFileSrc 不可用时继续走 OSS 兜底。
		}
	}

	let url = blob.url && !isWebviewLocalUri(blob.url) ? blob.url : "";
	let saved = url ? await deps.download(blob.id, url).catch(() => null) : null;
	if (!saved) {
		try {
			const fresh = await deps.resolveUrl(blob.id);
			if (fresh && fresh !== url) {
				url = fresh;
				saved = await deps.download(blob.id, fresh).catch(() => null);
			}
		} catch {
			// 服务端无记录/离线：保留原映射，显示层继续给出原始失败态。
		}
	}
	if (!saved?.localUri) return null;
	const recovered: AssetBlob = { ...saved, id: blob.id, url: saved.url || url || blob.url };
	deps.register(recovered);
	return recovered;
}

/** 恢复后用于改写项目快照的精确引用表（路径仍写路径，显示源统一写新 localUri）。 */
export function buildRecoveredRefRewrites(
	before: AssetBlob,
	after: AssetBlob,
	options?: { includeRemoteAliases?: boolean },
): Map<string, string> {
	const out = new Map<string, string>();
	if (before.localPath && after.localPath && before.localPath !== after.localPath) {
		out.set(before.localPath, after.localPath);
	}
	if (!after.localUri) return out;
	const aliases = [
		before.localUri,
		...(options?.includeRemoteAliases === false
			? []
			: [before.url, before.srcUri, ...(before.pastUrls || []), after.url]),
	];
	for (const alias of aliases) if (alias && alias !== after.localUri) out.set(alias, after.localUri);
	return out;
}

function productionDeps(projectInstanceId: string): AssetRestoreDeps {
	return {
		fileExists: async (path) => {
			const { exists } = await import("@tauri-apps/plugin-fs");
			return exists(path);
		},
		toDisplayUri: async (path) => {
			const { convertFileSrc } = await import("@tauri-apps/api/core");
			return convertFileSrc(path);
		},
		download: (id, url) => saveRemoteAsset(id, url),
		resolveUrl: (id) => managedClient.resolveAssetUrl(id),
		register: (blob) => {
			const current = useProjectStore.getState();
			if (current.projectInstanceId === projectInstanceId) {
				current.registerAssetBlob(blob);
				current.scheduleAutoSave("canvas");
			}
		},
	};
}

/** 同一 id 同时只恢复一次，避免一屏多个缩略图并发重复下载。 */
const restoring = new Map<string, Promise<AssetBlob | null>>();

export function ensureAssetBlobLocal(blob: AssetBlob): Promise<AssetBlob | null> {
	if (!isTauri()) return Promise.resolve(null);
	const projectInstanceId = useProjectStore.getState().projectInstanceId;
	const restoreKey = `${projectInstanceId}:${blob.id}`;
	const active = restoring.get(restoreKey);
	if (active) return active;
	const task = restoreAssetBlob(blob, productionDeps(projectInstanceId)).finally(() => restoring.delete(restoreKey));
	restoring.set(restoreKey, task);
	return task;
}

function displayFallbackId(uri: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < uri.length; i++) { h ^= uri.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return "disp" + (h >>> 0).toString(36);
}

/** useDisplayUri 的统一异步解析：本地映射必须先验文件存在，缺失时恢复到同一个台账 id。 */
export async function resolveDisplayUri(uri: string): Promise<string> {
	if (!uri) return "";
	const ps = useProjectStore.getState();
	const mapped = ps.blobByUri(uri) ?? Object.values(ps.assetBlobs).find((b) => b.localPath === uri);
	if (!isTauri()) {
		if (mapped?.url && (uri.startsWith("blob:") || isWebviewLocalUri(uri) || uri === mapped.localPath)) return mapped.url;
		return uri;
	}
	if (mapped) {
		const restored = await ensureAssetBlobLocal(mapped);
		if (restored?.localUri) return restored.localUri;
		return mapped.localUri || mapped.url || uri;
	}
	if (!/^https?:/i.test(uri) || isWebviewLocalUri(uri)) return uri;
	// 无台账的普通远程结果维持既有兜底，但只在确实没有 id 映射时才使用 uri 哈希。
	const fallback: AssetBlob = { id: displayFallbackId(uri), url: uri, srcUri: uri };
	const restored = await ensureAssetBlobLocal(fallback);
	return restored?.localUri || uri;
}

function rewriteValue<T>(value: T, rewrites: Map<string, string>): T {
	if (typeof value === "string") return (rewrites.get(value) ?? value) as T;
	if (Array.isArray(value)) return value.map((item) => rewriteValue(item, rewrites)) as T;
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		out[rewrites.get(key) ?? key] = rewriteValue(item, rewrites);
	}
	return out as T;
}

/** 把导入项目各数据域里的旧本地 uri / 公网快照改成刚恢复出的本地显示 uri。 */
function rewriteLoadedProjectRefs(rewrites: Map<string, string>): void {
	if (!rewrites.size) return;
	useProjectStore.setState((s) => ({
		fileRefs: rewriteValue(s.fileRefs, rewrites),
		coverImage: rewriteValue(s.coverImage, rewrites),
		characters: rewriteValue(s.characters, rewrites),
		scenes: rewriteValue(s.scenes, rewrites),
		items: rewriteValue(s.items, rewrites),
		organisms: rewriteValue(s.organisms, rewrites),
		crowds: rewriteValue(s.crowds, rewrites),
		episodes: rewriteValue(s.episodes, rewrites),
		canvases: rewriteValue(s.canvases, rewrites),
		pendingGens: rewriteValue(s.pendingGens, rewrites),
		inferTasks: rewriteValue(s.inferTasks, rewrites),
		analysisTask: rewriteValue(s.analysisTask, rewrites),
		genMeta: rewriteValue(s.genMeta, rewrites),
		assetRefImages: rewriteValue(s.assetRefImages, rewrites),
		rtcDocs: rewriteValue(s.rtcDocs, rewrites),
		isDirty: true,
	}));
	useCanvasStore.setState((s) => ({
		nodes: rewriteValue(s.nodes, rewrites),
		edges: rewriteValue(s.edges, rewrites),
		groups: rewriteValue(s.groups, rewrites),
	}));
	useLibraryStore.setState((s) => ({ assets: rewriteValue(s.assets, rewrites) }));
	useCommitStore.setState((s) => ({ commits: rewriteValue(s.commits, rewrites) }));
	useProjectStore.getState().scheduleAutoSave("canvas");
}

const batchTasks = new Map<string, Promise<number>>();

/**
 * 项目加载/导入后的批量自愈。三路并发，避免大项目串行过慢；项目中途切换则放弃回写，杜绝串台。
 * 返回实际恢复/刷新过的映射数。
 */
export function healProjectAssetBlobs(): Promise<number> {
	if (!isTauri()) return Promise.resolve(0);
	const initial = useProjectStore.getState();
	const instanceId = initial.projectInstanceId;
	const active = batchTasks.get(instanceId);
	if (active) return active;
	const task = (async () => {
		const blobs = Object.values(initial.assetBlobs);
		let cursor = 0;
		let fixed = 0;
		const rewrites = new Map<string, string>();
		const worker = async () => {
			while (cursor < blobs.length && useProjectStore.getState().projectInstanceId === instanceId) {
				const before = blobs[cursor++];
				const after = await ensureAssetBlobLocal(before);
				if (!after) continue;
				if (after !== before) fixed++;
				// 普通项目的本地副本本来就有效时，不把请求字段里的公网 URL 改成本地 URI；
				// 仅「无本地路径/恢复到了新路径」（portable/跨机导入）需要把公网显示快照一并本地化。
				const includeRemoteAliases = !before.localPath || before.localPath !== after.localPath;
				for (const [from, to] of buildRecoveredRefRewrites(before, after, { includeRemoteAliases })) rewrites.set(from, to);
			}
		};
		await Promise.all(Array.from({ length: Math.min(3, blobs.length) }, () => worker()));
		if (useProjectStore.getState().projectInstanceId === instanceId) rewriteLoadedProjectRefs(rewrites);
		return fixed;
	})().finally(() => batchTasks.delete(instanceId));
	batchTasks.set(instanceId, task);
	return task;
}
