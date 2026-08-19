/**
 * libraryHeal —— 项目加载后的「本地素材库显示自愈」（第145轮）。
 *
 * 根因：本地上传当时若没落成本地副本（saveRemoteAsset 失败/非 Tauri），显示 uri 是会话级
 * `blob:` objectURL——随项目持久化后重开必死；另有 uri 为远程 https 的记录在 Tauri 下被 CSP 拦（裂图）。
 * 观感即用户报的「素材上传后经常丢失、要重新上传才显示」。
 *
 * 自愈（id 是真理、url 是缓存）：项目加载后对每条素材库记录重解显示 uri——
 *   ① 本地原件在（localPath 存在且文件在）→ convertFileSrc 直接显示；
 *   ② 三元映射有可用 localUri（asset:// / asset.localhost）→ 用；
 *   ③ 凭 公网 url 重新下载本地副本（saveRemoteAsset）→ 登记映射 + 换显示 uri；
 *   ④ 浏览器（非 Tauri 无 CSP）→ 死 blob: 直接换成公网 url。
 * 修好回写 libraryStore + 标脏（下次保存随项目落盘，一次自愈永久生效）；无线索的保持原样（不编造）。
 * 调用点：projectStore.loadFromPath / 浏览器导入（fire-and-forget，动态 import 防循环依赖）。
 */
import { useLibraryStore, type Asset } from "@/store/libraryStore";
import { useProjectStore } from "@/store/projectStore";
import { saveRemoteAsset } from "@/services/assetPersist";
import { isWebviewLocalUri } from "@/lib/publicUrl";

const isTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** 并发防重：加载/导入接连触发时只跑一轮 */
let running = false;

/** 自愈素材库显示 uri；返回修复条数（供测试/日志）。 */
export async function healLibraryAssets(): Promise<number> {
	if (running) return 0;
	running = true;
	try {
		const ps = useProjectStore.getState();
		const lib = useLibraryStore.getState().assets;
		const fixes: Record<string, Partial<Asset>> = {};
		for (const a of Object.values(lib)) {
			if (a.deletedByUser) continue;
			const uriDead = !a.uri || a.uri.startsWith("blob:"); // 跨会话必死（objectURL）
			const uriRemote = /^https?:/i.test(a.uri) && !isWebviewLocalUri(a.uri); // Tauri CSP 下裂图
			if (!uriDead && !uriRemote) continue; // asset:// / asset.localhost / data: 均可显示，不动
			const blob =
				(a.serverAssetId ? ps.assetBlobs[a.serverAssetId] : undefined) ??
				ps.assetBlobs[a.id] ??
				ps.blobByUri(a.uri);
			// ① 本地原件在 → 直接转显示 uri（最快、离线可用）
			const localPath = a.localPath || blob?.localPath;
			if (localPath && isTauri()) {
				try {
					const { exists } = await import("@tauri-apps/plugin-fs");
					if (await exists(localPath)) {
						const { convertFileSrc } = await import("@tauri-apps/api/core");
						fixes[a.id] = { uri: convertFileSrc(localPath), localPath };
						continue;
					}
				} catch { /* 文件系统不可用 → 走下载兜底 */ }
			}
			// ② 三元映射有可用本地显示 uri（blob: 已在加载时被 sanitizeAssetBlobs 剥除，此处必非死链）
			if (blob?.localUri) { fixes[a.id] = { uri: blob.localUri }; continue; }
			// ③/④ 凭公网 url 兜底
			const url = blob?.url || (uriRemote ? a.uri : "");
			if (!url) continue; // 无任何线索：保持原样（报错优于编造，重新上传即恢复）
			if (!isTauri()) { if (uriDead) fixes[a.id] = { uri: url }; continue; } // 浏览器无 CSP：公网直显
			const saved = await saveRemoteAsset(a.serverAssetId || a.id, url); // 重新下载本地副本
			if (saved?.localUri) {
				useProjectStore.getState().registerAssetBlob(saved);
				fixes[a.id] = { uri: saved.localUri, localPath: saved.localPath ?? a.localPath };
			}
		}
		const n = Object.keys(fixes).length;
		if (n) {
			useLibraryStore.setState((s) => {
				const next = { ...s.assets };
				for (const [id, p] of Object.entries(fixes)) if (next[id]) next[id] = { ...next[id], ...p };
				return { assets: next };
			});
			useProjectStore.setState({ isDirty: true }); // 自愈结果随下次保存持久化
		}
		return n;
	} finally {
		running = false;
	}
}
