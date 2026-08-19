/**
 * assetCheck —— 手动「检查素材」：逐个资产探 OSS 直链是否可达，死链且本机有本地副本则自动重传修复。
 *
 * 三处入口共用：画布节点右键（本节点结果+素材）/ 资产界面·资产助手右键（单资产的图）/ 资产界面一键检查全部。
 * 检查=服务端 HEAD 探活（绕 webview CORS，可靠）；修复=本地字节 reput 写回 OSS 原键（url 不变，见 assetHeal/服务端）。
 * 约束同选项②：仅 Tauri + 台账真实资产 + 有本地副本才能修复；无副本只报告「无法修复」。
 */
import { useProjectStore } from "@/store/projectStore";
import { useCanvasStore } from "@/store/canvasStore";
import { useLibraryStore } from "@/store/libraryStore";
import { managedClient } from "@/services/managedClient";
import { getNodeMaterialItems } from "@/canvas/nodeMaterials";
import { useAssetCheckStore, type CheckStatus, type CheckItemResult, type CheckReport } from "@/store/assetCheckStore";

/** 真·服务端台账资产 id 前缀（自愈只对这些有效，其余客户端派生 id 无 OSS 原键） */
const LEDGER_ID_RE = /^(C|A|G|M|S|P|video|audio|TP)\d/;
const isTauriEnv = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

export interface CheckTarget {
	id: string;
	name?: string;
	/** 反查不到台账资产 id（无 OSS 记录）——不发探活请求，直接报「missing」异常。
	 * ⚠ 全面「OSS 提交+本地预览」模式下软件内素材都应有 OSS 记录，这类项是问题本身，
	 * 解析层必须保留进报告（勿再静默丢弃/跳过，第121轮用户定）。id 此时=显示 uri（仅作去重键）。 */
	noLedger?: boolean;
}

export interface CheckDeps {
	isTauri: () => boolean;
	blobById: (id: string) => { url?: string; localPath?: string; mime?: string; ext?: string } | undefined;
	/** 按资产 id 在项目 assets/ 目录里扫描本地副本（映射表缺记录时兜底）。
	 *  返回 { localPath, ext, mime? }；未找到返回 null。仅 Tauri 环境有效。 */
	findLocalById: (id: string) => Promise<{ localPath: string; ext: string; mime?: string } | null>;
	readLocal: (path: string) => Promise<Uint8Array>;
	alive: (id: string) => Promise<{ alive: boolean; url?: string }>;
	reput: (id: string, blob: Blob, name: string) => Promise<{ url: string } | null>;
	/** 服务端 url 变化（旧 OSS 桥接恢复/别人已恢复）→ 回写三元映射，后续提交直接用新链接 */
	adoptUrl: (id: string, url: string) => void;
}

const adoptIntoStore = (id: string, url: string): void => {
	const cur = useProjectStore.getState().assetBlobs[id];
	if (!cur || cur.url !== url) useProjectStore.getState().registerAssetBlob({ id, url });
};

async function findLocalByIdImpl(id: string): Promise<{ localPath: string; ext: string; mime?: string } | null> {
	try {
		const st = useProjectStore.getState();
		let savePath = st.savePath;
		if (!savePath) return null;
		const { join, dirname } = await import("@tauri-apps/api/path");
		const assets = await join(await dirname(savePath), "assets");
		const { exists } = await import("@tauri-apps/plugin-fs");
		// 与 saveUploadedLocal/saveRemoteAsset 一致：文件名 = <id>.<ext>
		for (const ext of ["png", "jpg", "jpeg", "webp", "mp4", "webm", "mov", "mp3", "wav", "ogg", "bin"]) {
			const p = await join(assets, `${id}.${ext}`);
			if (await exists(p)) {
				const mime = ext === "jpg" ? "image/jpeg" : `${ext.startsWith("video") ? "video" : ext.startsWith("audio") ? "audio" : "image"}/${ext}`;
				return { localPath: p, ext, mime };
			}
		}
	} catch { /* 非 Tauri / 无项目 */ }
	return null;
}

const defaultDeps: CheckDeps = {
	isTauri: isTauriEnv,
	blobById: (id) => useProjectStore.getState().assetBlobs[id],
	findLocalById: findLocalByIdImpl,
	readLocal: async (path) => {
		const { readFile } = await import("@tauri-apps/plugin-fs");
		return readFile(path);
	},
	alive: (id) => managedClient.assetAlive(id),
	reput: (id, blob, name) => managedClient.reputAsset(id, blob, name),
	adoptUrl: adoptIntoStore,
};

/** 单个资产：探活→死链则本地副本重传修复。第224轮起顺带把服务端当前 url 回写本机映射
 * （旧 OSS 桥接：别人恢复过的直接换用其链接；自己恢复的记下新链接——不重复上传）。返回状态。
 *
 * 本地副本查找顺序：
 *  1. 三元映射 assetBlobs[id].localPath（已登记、项目文件持久化下来的）
 *  2. findLocalById fallback——扫描项目 assets/ 目录按 <id>.<ext> 文件名查找（映射表
 *     缺记录时仍能从磁盘找到，修复后登记进映射避免下次再扫）。 */
export async function checkOne(target: CheckTarget, deps: CheckDeps = defaultDeps): Promise<CheckStatus> {
	if (target.noLedger || !LEDGER_ID_RE.test(target.id)) return "missing"; // 无 OSS 记录=异常（非"跳过"）
	const a = await deps.alive(target.id);
	if (a.alive) {
		if (a.url) deps.adoptUrl(target.id, a.url);
		return "ok";
	}
	// 死链 → 有本地副本才能修复（选项②固有边界）
	if (!deps.isTauri()) return "dead";

	// ① 先查三元映射（快路径）
	let blob = deps.blobById(target.id);

	// ② 映射缺记录时 fallback 扫项目 assets/ 目录（修复"明明本地有却说没有"）
	if (!blob?.localPath) {
		const found = await deps.findLocalById(target.id);
		if (found) {
			const cur = useProjectStore.getState().assetBlobs[target.id];
			useProjectStore.getState().registerAssetBlob({ id: target.id, url: cur?.url, localPath: found.localPath, ext: found.ext, mime: found.mime });
			blob = { url: cur?.url, localPath: found.localPath, ext: found.ext, mime: found.mime };
		}
	}
	if (!blob?.localPath) return "dead";

	try {
		const bytes = await deps.readLocal(blob.localPath);
		const mime = blob.mime || "application/octet-stream";
		const res = await deps.reput(target.id, new Blob([bytes as unknown as BlobPart], { type: mime }), `${target.id}.${blob.ext || "bin"}`);
		if (res?.url) { deps.adoptUrl(target.id, res.url); return "healed"; }
		return "dead";
	} catch (e) {
		console.warn("[assetCheck] reput failed:", e);
		return "dead";
	}
}

/** 对结果计数汇总（纯函数） */
export function summarize(items: CheckItemResult[]): CheckReport {
	return {
		total: items.length,
		ok: items.filter((i) => i.status === "ok").length,
		healed: items.filter((i) => i.status === "healed").length,
		dead: items.filter((i) => i.status === "dead").length,
		missing: items.filter((i) => i.status === "missing").length,
		items,
	};
}

/** 去重（按 id）+ 并发受限地逐个检查，onProgress 报进度。 */
export async function checkAssetTargets(
	targets: CheckTarget[],
	onProgress?: (done: number, total: number) => void,
	deps: CheckDeps = defaultDeps,
): Promise<CheckReport> {
	const list = dedupById(targets);
	const items: CheckItemResult[] = [];
	let done = 0;
	let idx = 0;
	const CONC = 6;
	const worker = async () => {
		while (idx < list.length) {
			const t = list[idx++];
			const status = await checkOne(t, deps);
			items.push({ id: t.id, name: t.name, status });
			done += 1;
			onProgress?.(done, list.length);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, worker));
	return summarize(items);
}

/** 编排：开进度弹窗 → 检查 → 出报告。UI 入口统一调这个。 */
export async function runAssetCheck(targets: CheckTarget[], title: string): Promise<void> {
	const list = dedupById(targets);
	const store = useAssetCheckStore.getState();
	if (!list.length) {
		store.showEmpty(title);
		return;
	}
	store.start(title, list.length);
	const report = await checkAssetTargets(list, (done) => useAssetCheckStore.getState().setProgress(done));
	useAssetCheckStore.getState().finish(report);
}

// ── 各入口的目标解析（uri → 台账资产 id；反查不到=noLedger 异常项，保留进报告不丢弃） ──

/** 由显示 uri 解析检查目标：三元映射反查台账 id；查不到 → noLedger 异常项（id=uri 作去重键）。空 uri（无图）返回 undefined。 */
function targetFromUri(uri: string | undefined, name?: string): CheckTarget | undefined {
	if (!uri) return undefined;
	const b = useProjectStore.getState().blobByUri(uri);
	if (b?.id && LEDGER_ID_RE.test(b.id)) return { id: b.id, name };
	return { id: uri, name, noLedger: true };
}

/** 由画布库资产 id 解析检查目标。⚠ 节点 resultAssetId/resultHistory 存的是**库资产派生 id**
 * （`asset-<taskId>`，libraryStore 的键）——真台账 id 在库资产的 serverAssetId / uri 三元映射里，
 * 不解析直接当台账 id 用会把有 OSS 记录的生成图误报「无 OSS 记录」（第121轮用户实测踩中）。 */
function targetFromLibraryAssetId(libId: string, name?: string): CheckTarget {
	if (LEDGER_ID_RE.test(libId)) return { id: libId, name }; // 本就是台账 id（拖入资产等场景）
	const asset = useLibraryStore.getState().assets[libId];
	if (asset) {
		if (asset.serverAssetId && LEDGER_ID_RE.test(asset.serverAssetId)) return { id: asset.serverAssetId, name: name || asset.name };
		const t = targetFromUri(asset.uri, name || asset.name);
		if (t) return t;
	}
	return { id: libId, name, noLedger: true }; // 库资产已删/无任何 OSS 线索 → 异常项如实报告
}

export function dedupById(targets: CheckTarget[]): CheckTarget[] {
	const seen = new Map<string, CheckTarget>();
	for (const t of targets) if (t.id && !seen.has(t.id)) seen.set(t.id, t);
	return [...seen.values()];
}

/** 画布节点：本节点结果资产（+历史）+ 全部素材（上游连线+自加）对应的台账资产 */
export function nodeCheckTargets(nodeId: string): CheckTarget[] {
	const node = useCanvasStore.getState().nodes[nodeId];
	if (!node) return [];
	const name = (typeof node.data.title === "string" && node.data.title) || node.type;
	const out: CheckTarget[] = [];
	// 结果资产（含历史）：resultAssetId 是库资产派生 id，须解析出真台账 id（serverAssetId/uri 反查）
	if (node.data.resultAssetId) out.push(targetFromLibraryAssetId(node.data.resultAssetId, name));
	for (const h of node.data.resultHistory ?? []) out.push(targetFromLibraryAssetId(h, name));
	for (const m of getNodeMaterialItems(nodeId)) {
		const t = targetFromUri(m.uri, m.name || m.tag);
		if (t) out.push(t);
	}
	return dedupById(out);
}

interface AssetEntityLike {
	name?: string;
	image?: string;
	images?: string[];
	variants?: Array<{ image?: string; label?: string; name?: string }>;
	/** 音色绑定（角色/五类均可选，voiceAssetId=台账 id、voiceUri=显示 uri） */
	voiceUri?: string;
	voiceAssetId?: string;
}

/** 单个资产实体（角色/场景/…）：主图 + 历史图 + 造型图 + 音色 对应的台账资产 */
export function assetEntityTargets(a: AssetEntityLike): CheckTarget[] {
	const out: CheckTarget[] = [];
	const push = (uri?: string, nm?: string) => {
		const t = targetFromUri(uri, nm || a.name);
		if (t) out.push(t);
	};
	push(a.image, a.name);
	for (const u of a.images ?? []) push(u, a.name);
	for (const v of a.variants ?? []) push(v.image, v.label || v.name || a.name);
	// 音色音频：voiceAssetId 优先（台账 id 直取），否则走 uri 反查
	if (a.voiceAssetId && LEDGER_ID_RE.test(a.voiceAssetId)) {
		out.push({ id: a.voiceAssetId, name: `${a.name}（音色）` });
	} else if (a.voiceUri) {
		const t = targetFromUri(a.voiceUri, `${a.name}（音色）`);
		if (t) out.push(t);
	}
	return dedupById(out);
}

/** 任意一组显示 uri（资产助手条目：主图 + 造型图） */
export function uriCheckTargets(entries: Array<{ uri?: string; name?: string }>): CheckTarget[] {
	const out: CheckTarget[] = [];
	for (const e of entries) {
		const t = targetFromUri(e.uri, e.name);
		if (t) out.push(t);
	}
	return dedupById(out);
}

/** 本项目全部资产（五类实体各自的主图/历史/造型） */
export function allProjectAssetTargets(): CheckTarget[] {
	const s = useProjectStore.getState();
	const arrays: AssetEntityLike[][] = [s.characters, s.scenes, s.items, s.organisms, s.crowds].map((a) => (a ?? []) as AssetEntityLike[]);
	return dedupById(arrays.flat().flatMap((a) => assetEntityTargets(a)));
}
