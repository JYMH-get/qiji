/**
 * assetHeal —— OSS「死链自愈」：垫图/素材依赖的 OSS 直链若已丢失，且本机存有该资产的本地副本，
 * 就把本地字节重新上传、由服务端写回 OSS 原对象键（url 不变），反向修复丢失的云端对象。
 *
 * 触发点：ensurePublicUrl（发上游前把素材公网化的唯一入口）——正是死链会导致生成失败之处。
 * 约束（选项②的固有边界）：仅 Tauri（需本地副本）+ 台账真实资产（"disp"/"bk" 客户端派生 id 无 OSS 原键，跳过）。
 * 判活走服务端 HEAD（绕 webview CORS，可靠）；本会话确认活的 id 缓存，不重复探测（不拖慢每次提交）。
 */
import { useProjectStore } from "@/store/projectStore";
import { managedClient } from "@/services/managedClient";

/** 真·服务端台账资产 id 前缀（自愈只对这些有效，其余客户端派生 id 无 OSS 原键） */
const LEDGER_ID_RE = /^(C|A|G|M|S|P|video|audio|TP)\d/;

/** 本会话已确认「活」的资产 id：确认过就不再探测 */
const aliveThisSession = new Set<string>();
/** 测试用：清空会话缓存 */
export function _resetAliveCache(): void {
	aliveThisSession.clear();
}

export interface HealDeps {
	isTauri: () => boolean;
	blobByUri: (uri: string) => { id?: string; url?: string; localPath?: string; mime?: string; ext?: string } | undefined;
	readLocal: (path: string) => Promise<Uint8Array>;
	alive: (id: string) => Promise<{ alive: boolean; url?: string }>;
	reput: (id: string, blob: Blob, name: string) => Promise<{ url: string } | null>;
	/** 服务端 url 变化（旧 OSS 桥接恢复/别人已恢复）→ 回写三元映射，后续提交直接用新链接 */
	adoptUrl: (id: string, url: string) => void;
}

const isTauriEnv = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

const defaultDeps: HealDeps = {
	isTauri: isTauriEnv,
	blobByUri: (uri) => useProjectStore.getState().blobByUri(uri),
	readLocal: async (path) => {
		const { readFile } = await import("@tauri-apps/plugin-fs");
		return readFile(path);
	},
	alive: (id) => managedClient.assetAlive(id),
	reput: (id, blob, name) => managedClient.reputAsset(id, blob, name),
	adoptUrl: (id, url) => {
		const cur = useProjectStore.getState().assetBlobs[id];
		if (!cur || cur.url !== url) useProjectStore.getState().registerAssetBlob({ id, url });
	},
};

/**
 * 若 uri 指向「本机有本地副本的台账资产」、且服务端探测为死链 → 用本地字节重传修复，返回修复后的 url。
 * 第224轮（换 OSS 桥接）起 url 可能变化：旧桶链接恢复后=新域名+账号目录+旧路径；
 * 别人已恢复的（探活通过但服务端 url 与本机不同）直接换用服务端链接，不重复上传。
 * 无需/无法修复（非 Tauri / 无本地副本 / 派生 id / 判活 / 重传失败）时返回原 uri。
 */
export async function healPublicUrlIfDead(uri: string, deps: HealDeps = defaultDeps): Promise<string> {
	if (!uri || !deps.isTauri()) return uri;
	const blob = deps.blobByUri(uri);
	if (!blob?.id || !blob.localPath || !LEDGER_ID_RE.test(blob.id)) return uri;
	if (aliveThisSession.has(blob.id)) return uri;
	const a = await deps.alive(blob.id);
	if (a.alive) {
		aliveThisSession.add(blob.id);
		if (a.url && a.url !== uri) { deps.adoptUrl(blob.id, a.url); return a.url; } // 别人已桥接恢复 → 直接用
		return uri;
	}
	try {
		const bytes = await deps.readLocal(blob.localPath);
		const mime = blob.mime || "application/octet-stream";
		const name = `${blob.id}.${blob.ext || "bin"}`;
		const res = await deps.reput(blob.id, new Blob([bytes as unknown as BlobPart], { type: mime }), name);
		if (res?.url) { aliveThisSession.add(blob.id); deps.adoptUrl(blob.id, res.url); return res.url; }
	} catch (e) {
		console.warn("[assetHeal] reput failed:", e);
	}
	return uri;
}
