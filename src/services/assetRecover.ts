/**
 * assetRecover —— **单个资产恢复的唯一实现**（第254轮）。
 *
 * 此前有两份近似重复的实现且能力不对等：
 *  - assetHeal.healPublicUrlIfDead（提交前自愈）：有会话缓存，但**要求本地副本才肯往下走**，
 *    连「探活拿到服务端新链接」这种不需要副本的分支也被挡掉；无磁盘兜底扫描。
 *  - assetCheck.checkOne（手动检查素材）：有磁盘兜底扫描，但把「无副本」与「重传失败」
 *    混成同一个 dead 状态，弹窗一律说「本机无副本」（用户实报被这句话误导）。
 * 现在两边都薄封装本模块，杜绝再次分叉。
 *
 * 恢复顺序（缺一不可）：
 *   ① 非台账 id → missing（不发请求）
 *   ② 探活 → 活：服务端 url 与本机不同就 adopt 并返回新链（**不需要本地副本**）
 *   ③ 探活 → 台账无此 id（404）→ missing（重传也无处可写）
 *   ④ 死链 → 找本地副本：三元映射 localPath →（缺/文件已删）磁盘扫 <项目>/assets/<id>.<ext>
 *   ⑤ 有副本 → reput（失败退避重试 1 次，对齐第197轮 createAsset 的抗抖）→ healed / failed(带原因)
 */
import { useProjectStore } from "@/store/projectStore";
import { managedClient } from "@/services/managedClient";

/** 真·服务端台账资产 id 前缀（恢复只对这些有效，其余客户端派生 id（disp/bk/LC-）无 OSS 原键） */
export const LEDGER_ID_RE = /^(C|A|G|M|S|P|video|audio|TP)\d/;

export type RecoverStatus =
	| "ok"       // 直链存活（url 未变）
	| "adopted"  // 直链存活但服务端 url 已变（别人先桥接恢复过）→ 已换用新链
	| "healed"   // 死链 → 已用本地副本重传恢复
	| "dead"     // 死链且本机无副本 → 无从恢复
	| "failed"   // 死链、本机有副本，但重传失败（带 reason，可重试）
	| "missing"; // 非台账 id / 服务端台账里没有这个资产

export interface RecoverResult {
	status: RecoverStatus;
	/** 当前应当使用的公网 url（ok/adopted/healed 时有值） */
	url?: string;
	/** failed 时的失败原因（HTTP 码 + 服务端文案 / 网络异常） */
	reason?: string;
}

export interface RecoverDeps {
	isTauri: () => boolean;
	blobById: (id: string) => { url?: string; localPath?: string; mime?: string; ext?: string } | undefined;
	/** 按资产 id 扫项目 assets/ 目录找本地副本（三元映射缺记录时兜底）；未找到返回 null */
	findLocalById: (id: string) => Promise<{ localPath: string; ext: string; mime?: string } | null>;
	/** 本地文件是否还在磁盘上（副本被删/项目搬家后映射里的路径会失效） */
	fileExists: (path: string) => Promise<boolean>;
	readLocal: (path: string) => Promise<Uint8Array>;
	alive: (id: string) => Promise<{ alive: boolean; missing?: boolean; url?: string }>;
	reput: (id: string, blob: Blob, name: string) => Promise<{ ok: true; id: string; url: string } | { ok: false; error: string }>;
	/** 服务端 url 变化 → 回写三元映射（旧 url 由 mergeAssetBlob 自动归档进 pastUrls） */
	adoptUrl: (id: string, url: string) => void;
	/** 本地副本刚被找到（磁盘扫描兜底）→ 登记进映射，下次不用再扫 */
	registerLocal: (id: string, found: { localPath: string; ext: string; mime?: string }) => void;
}

const isTauriEnv = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

async function findLocalByIdImpl(id: string): Promise<{ localPath: string; ext: string; mime?: string } | null> {
	try {
		const savePath = useProjectStore.getState().savePath;
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

export const defaultRecoverDeps: RecoverDeps = {
	isTauri: isTauriEnv,
	blobById: (id) => useProjectStore.getState().assetBlobs[id],
	findLocalById: findLocalByIdImpl,
	fileExists: async (path) => {
		try {
			const { exists } = await import("@tauri-apps/plugin-fs");
			return await exists(path);
		} catch {
			return false;
		}
	},
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
	registerLocal: (id, found) => {
		useProjectStore.getState().registerAssetBlob({ id, localPath: found.localPath, ext: found.ext, mime: found.mime });
	},
};

/** 本会话已确认「活」的资产 id（cache:"session" 时生效，不拖慢管理端渠道的每次提交） */
const aliveThisSession = new Set<string>();
/** 测试用：清空会话缓存 */
export function _resetAliveCache(): void {
	aliveThisSession.clear();
}

export interface RecoverOptions {
	/**
	 * "session"：本会话确认存活的 id 不再重复探测（管理端渠道提交路径，沿用既有行为）；
	 * "none"：每次都真探（第三方渠道 LibTV/即梦/ComfyUI——用户定：每条素材每次提交都探活）。
	 */
	cache?: "session" | "none";
	deps?: RecoverDeps;
	/** 重传失败后的退避（ms）——仅供测试注入，生产用默认值 */
	retryDelayMs?: number;
}

/** reput 重试退避（ms）：第197轮实锤对象存储 PUT 会被对端重置，一次退避重试即可吃掉绝大多数抖动 */
const REPUT_RETRY_DELAY_MS = 1200;

/** 恢复单个台账资产：探活 → 换链 / 本地副本重传。绝不抛错，一律以状态回报。 */
export async function recoverAsset(id: string, opts: RecoverOptions = {}): Promise<RecoverResult> {
	const deps = opts.deps ?? defaultRecoverDeps;
	const useCache = (opts.cache ?? "session") === "session";
	if (!id || !LEDGER_ID_RE.test(id)) return { status: "missing" };

	const known = deps.blobById(id);
	if (useCache && aliveThisSession.has(id)) return { status: "ok", url: known?.url };

	// ② 探活
	const a = await deps.alive(id);
	if (a.missing) return { status: "missing" };
	if (a.alive) {
		aliveThisSession.add(id);
		if (a.url && a.url !== known?.url) {
			deps.adoptUrl(id, a.url);
			return { status: "adopted", url: a.url };
		}
		return { status: "ok", url: a.url ?? known?.url };
	}

	// ④ 死链 → 本地副本（非 Tauri 无文件系统，直接判死）
	if (!deps.isTauri()) return { status: "dead" };
	let local: { localPath: string; ext?: string; mime?: string } | null = null;
	if (known?.localPath && (await deps.fileExists(known.localPath))) {
		local = { localPath: known.localPath, ext: known.ext, mime: known.mime };
	} else {
		const found = await deps.findLocalById(id);
		if (found) {
			deps.registerLocal(id, found);
			local = found;
		}
	}
	if (!local) return { status: "dead" };

	// ⑤ 重传（失败退避重试一次）
	let bytes: Uint8Array;
	try {
		bytes = await deps.readLocal(local.localPath);
	} catch (e) {
		return { status: "failed", reason: `读取本地副本失败：${(e as Error)?.message || e}` };
	}
	const mime = local.mime || "application/octet-stream";
	const name = `${id}.${local.ext || "bin"}`;
	let lastErr = "";
	for (let attempt = 1; attempt <= 2; attempt++) {
		const res = await deps.reput(id, new Blob([bytes as unknown as BlobPart], { type: mime }), name);
		if (res.ok) {
			aliveThisSession.add(id);
			if (res.url) deps.adoptUrl(id, res.url);
			return { status: "healed", url: res.url };
		}
		lastErr = res.error;
		if (attempt < 2) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? REPUT_RETRY_DELAY_MS));
	}
	return { status: "failed", reason: lastErr || "重传失败" };
}

/** 恢复结果是否给出了「可用的公网链接」 */
export function recoveredUrlOf(r: RecoverResult): string | undefined {
	return r.status === "ok" || r.status === "adopted" || r.status === "healed" ? r.url : undefined;
}

// ── 第三方渠道（LibTV / 即梦 / ComfyUI）素材 → 本地文件路径 ──
// 这三家的 CLI/HTTP 都只收**本地文件**，此前各有一份逐字相同的 resolveLocalPath，
// 三份都：不探活（用户实报「使用素材前没有探活素材 oss 链接」）、不校验本地文件是否还在磁盘上。
// 收口到这一份，加上探活与存在性校验。

/** 一次提交内的探活去重（同一 id 只探一次；不同提交之间不复用——用户定：每次提交都探活） */
export type ProbeScope = Map<string, RecoverResult>;
/** 每次提交新建一个探活作用域 */
export function newProbeScope(): ProbeScope {
	return new Map();
}

/**
 * 把一个素材 uri 解析成本地文件路径（第三方渠道专用）。
 *
 *  1. 台账资产 → **每次提交都探活**（scope 内按 id 去重）：链接换过就换用新链、死链就用本地副本重传恢复；
 *  2. 三元映射里的 localPath **须校验文件仍在磁盘上**才用（副本被删/项目搬家后路径会失效）；
 *  3. 落地：ensureLocalOriginal(探活后的有效 url)。
 *
 * 取不到返回空串——调用方一律明确报错整单拒（`@ImageN` 按素材顺序编号，静默丢一条会让
 * 后面全部引用错位，§9A 第118轮「一张都不许静默丢」）。
 */
export async function resolveMaterialLocalPath(
	uri: string,
	opts?: { name?: string; scope?: ProbeScope; deps?: RecoverDeps },
): Promise<string> {
	if (!uri) return "";
	const { useProjectStore: store } = await import("@/store/projectStore");
	const blob = store.getState().blobByUri(uri);

	// ① 台账资产：探活（换链 / 死链自愈）。派生 id（LC-/bk-/disp）与 data:/blob: 无从探，跳过。
	let effectiveUri = uri;
	const id = blob?.id;
	if (id && LEDGER_ID_RE.test(id)) {
		let r = opts?.scope?.get(id);
		if (!r) {
			r = await recoverAsset(id, { cache: "none", deps: opts?.deps });
			opts?.scope?.set(id, r);
		}
		const fresh = recoveredUrlOf(r);
		if (fresh) effectiveUri = fresh;
	}

	// ② 映射里的本地副本（须真的还在磁盘上）——探活后现查，自愈可能刚补登过 localPath
	const deps = opts?.deps ?? defaultRecoverDeps;
	const after = store.getState().blobByUri(effectiveUri) ?? blob;
	if (after?.localPath && (await deps.fileExists(after.localPath))) return after.localPath;

	// ③ 落地一份
	const { ensureLocalOriginal } = await import("@/services/assetPersist");
	const saved = await ensureLocalOriginal(effectiveUri, { name: opts?.name });
	return saved?.localPath || "";
}

/** 同上，取不到直接抛带素材名的明确错误（三家渠道统一文案） */
export async function resolveMaterialLocalPathOrThrow(
	uri: string,
	channel: string,
	opts?: { name?: string; scope?: ProbeScope; deps?: RecoverDeps },
): Promise<string> {
	const path = await resolveMaterialLocalPath(uri, opts);
	if (!path) {
		throw new Error(`参考素材「${opts?.name || uri}」无法取得本地文件（云端链接已失效且本机无副本），无法提交${channel}——可先用「检查素材」修复后重试`);
	}
	return path;
}

