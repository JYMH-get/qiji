/**
 * 资产存储（SQLite 台账 + OSS 优先 + 内存字节兜底）。
 *
 * 规格不变量：资产 id 全局唯一、永不复用，由管理端分配；按**类型前缀**编号。
 *  - 前缀：C 核心人物 / A 配角反派神明 / G 群像 / M 怪物异兽 / S 场景 / P 道具 / video / audio / TP 临时。
 *  - 文件名即 id：C00000123.png、video00000123.mp4（OSS key 仅 ASCII，避免非 ASCII 路径在 S3 兼容服务上编码不一致）。
 * 台账落 SQLite（data/qiji.db 的 assets / asset_seqs 两表）——资产无上限增长且按 id 索引查，
 * 用 JSON 全量进内存 + 每次插入整文件重写会越攒越卡；SQLite 单条索引读写微秒级、不阻塞 event loop。
 * 字节：配置 OSS 时上传到 OSS（公有读直链）；否则留内存供 /raw 兜底（不落库、重启即失，属降级模式）。
 * 首启一次性从旧 data/assets.json 迁移（幂等：仅在表空时导入，保留原 id 与每前缀 seq）。
 */
import type { Capability } from "../contract.ts";
import { loadJson, DATA_DIR } from "./db.ts";
import { db } from "./sqlite.ts";
import { isOssConfigured, ossPut, ossPublicUrl, ossDelete } from "./oss.ts";
import { activeProfile, keyFor, locate, profileOf, type StorageProfile } from "./storage.ts";
import { parseMp4DurationMs } from "../mp4meta.ts";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

const LEGACY_FILE = "assets.json";

// ── 资产归属上下文（P0）──
// 资产是在很深的调用链里产出的：routes → dispatchGenerate → 各家翻译器 → 轮询循环 →
// rehostVideo → createAsset，中间隔着 20 多个翻译器和十几个异步轮询驱动。
// 要给每条台账记上「是谁产的」，逐层加参数意味着改遍所有翻译器，且漏一处就静默产出
// user_id 为空的记录（配额算不准，且事后无从追溯）。
// 故用 AsyncLocalStorage 在请求入口挂一次，createAsset 自取——异步链（含 void 起的
// 后台轮询循环）会自动继承上下文，新增翻译器零改动。
// 例外：进程重启后的 resumeVideoPolling 不在任何请求上下文里 → 归属为空（可接受，
// 量极小且这些资产本就属于重启前的任务）。
export interface AssetOwner {
	userId?: string;
	agentId?: string;
}
const ownerCtx = new AsyncLocalStorage<AssetOwner>();

/** 在归属上下文中执行（routes 的生成/上传入口调用一次即可覆盖整条链） */
export function runWithAssetOwner<T>(owner: AssetOwner, fn: () => T): T {
	return ownerCtx.run(owner, fn);
}
/** 当前归属（不在上下文中时为 undefined） */
export function currentAssetOwner(): AssetOwner | undefined {
	return ownerCtx.getStore();
}

// ── 账号目录段（第224轮：新对象键布局 acct/kind/yyyy/mm/dd）──
// 「谁生成的用谁的登录账号」做目录名。⚠ 对象键仅 ASCII 是硬约束（§9）——账号按用户说法
// 必然是字母数字组合，但邮箱/历史数据可能带其它字符：归一时只留 [A-Za-z0-9._-]，
// 归一后为空则退回用户 id，再不行 "anon"。
// 账号查询经注入（index.ts setAssetAccountResolver）——防 assets.ts ↔ users.ts 循环引用（logs.ts 同款先例）。
let acctResolver: ((userId: string) => string | undefined) | undefined;
export function setAssetAccountResolver(fn: (userId: string) => string | undefined): void {
	acctResolver = fn;
}
/** 把账号/任意字符串归一成对象键目录段（仅 ASCII 安全字符） */
export function sanitizeAcctSegment(s: string | undefined | null): string {
	return (s ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
}
/** 归属 → 对象键账号目录段：登录账号 > 用户 id > "anon" */
function acctSegmentOf(owner?: AssetOwner): string {
	const uid = owner?.userId;
	if (!uid) return "anon";
	return sanitizeAcctSegment(acctResolver?.(uid)) || sanitizeAcctSegment(uid) || "anon";
}

// ── 旧 OSS 桥接（第224轮）──
// 用户决策：整体换新对象存储、旧桶数据全部舍弃，用户凭本地副本恢复。
// 判定「旧桶链接」的依据 = settings.json 的 ossBridgeOldBases（缺省含已知旧公网基址）；
// 命中旧基址的行：isAssetAlive 直接判死（旧数据已舍弃，不必发网络探测），
// reputAsset 恢复时改传**新布局键**：`<恢复者账号>/<旧对象键路径>`（域名换、路径保形，谁先恢复用谁的目录；
// 台账一资产一行 → 第二个人检查时探活已通过，直接复用先恢复者的链接，天然不重复上传）。
const BRIDGE_OLD_BASES_DEFAULT = ["https://jianqiji-qiji.cn-nb1.rains3.com"];
function bridgeOldBases(): string[] {
	const raw = loadJson<{ ossBridgeOldBases?: unknown }>("settings.json", {}).ossBridgeOldBases;
	if (Array.isArray(raw) && raw.length) return raw.filter((x): x is string => typeof x === "string" && !!x);
	return BRIDGE_OLD_BASES_DEFAULT;
}
/** url 是否指向已舍弃的旧 OSS（需要桥接恢复） */
export function isBridgeOldUrl(u: string | undefined | null): boolean {
	if (!u) return false;
	return bridgeOldBases().some((b) => u.startsWith(b));
}
/** SQL 片段：仅我们在管的行（url 非旧基址）。容量统计与保留策略预览共用同一口径。 */
export function notOldUrlCondSql(): string {
	return bridgeOldBases()
		.map((b) => `url NOT LIKE '${b.replace(/'/g, "''")}%'`)
		.join(" AND ");
}

export interface AssetRecord {
	id: string; // 类型前缀 + 8 位，如 C00000123
	type: Capability;
	contentType: string;
	name?: string; // 资产名（便于检索/展示）
	url: string; // OSS 公网直链；未配 OSS 时为空（走 /raw）
	ossKey?: string; // OSS 对象键，如 assets/C00000123.png
	/** 视频时长毫秒（第140轮，参考视频按秒计费缓存）：入库时解析；老资产首次计费探测后回填 */
	durationMs?: number;
	createdAt: string;
	/** 存储档（P0）：决定该行的对象在哪个桶、什么布局。缺省/NULL=legacy */
	storage?: string;
	/** 对象字节数（P0）：入库即写；存量由 scripts/reconcile.mjs 回填 */
	sizeBytes?: number;
	/** 产出者 / 其所属渠道商（P0）：配额与按商容量统计用；后台任务产出时可能为空 */
	userId?: string;
	agentId?: string;
	/** 内容 sha256（第224轮：上传去重；存量/直传行可能为空） */
	sha256?: string;
}

// ── 建表 ──
db.exec(`
	CREATE TABLE IF NOT EXISTS assets (
		id           TEXT PRIMARY KEY,
		type         TEXT NOT NULL,
		content_type TEXT NOT NULL,
		name         TEXT,
		url          TEXT NOT NULL DEFAULT '',
		oss_key      TEXT,
		created_at   TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS asset_seqs (
		prefix TEXT PRIMARY KEY,
		seq    INTEGER NOT NULL
	);
`);
// 第140轮：视频时长缓存列（参考视频按秒计费）——旧库补列（幂等；须在预编译含该列的语句前执行）
{
	const cols = db.prepare("PRAGMA table_info(assets)").all() as { name: string }[];
	if (!cols.some((c) => c.name === "duration_ms")) db.exec("ALTER TABLE assets ADD COLUMN duration_ms INTEGER");
}

// ── P0 存储改造：补列 + 建索引（幂等，与上面的 duration_ms 同模式）──
// 走「启动时自动迁移」而不是「先部署代码、再手工跑迁移脚本」，是为了消灭那段
// 「新代码已上线、新列还不存在」的空窗。scripts/migrate-p0.mjs 做的是同一件事，
// 两边都幂等，先跑哪个都行。
// ⚠ 只加列、只加索引，**一列都不动、一行都不删**——重建表迁移风险真、收益假。
{
	const cols = new Set((db.prepare("PRAGMA table_info(assets)").all() as { name: string }[]).map((c) => c.name));
	const ADD: [string, string][] = [
		["storage", "TEXT"], // 存储档：'legacy' | 'v2'…（NULL 一律按 legacy 解读，见 store/storage.ts）
		["size_bytes", "INTEGER"], // 对象字节数（配额与容量统计的基础）
		["user_id", "TEXT"], // 产出者（按用户配额/清理归属）
		["agent_id", "TEXT"], // 产出者所属渠道商（按商统计容量）
		["last_ref_at", "INTEGER"], // 最后被引用上报（epoch 秒）；NULL=从未被引用
		["purged_at", "INTEGER"], // 已清理墓碑（epoch 秒）；⚠ 行永不删，reputAsset 自愈依赖行存在
		["has_thumb", "INTEGER"], // 缩略图是否已生成（0/1）
		["sha256", "TEXT"], // 内容哈希（第224轮：换新 OSS 起的上传去重；存量为 NULL 不参与去重）
	];
	for (const [name, type] of ADD) if (!cols.has(name)) db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${type}`);
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at);
		CREATE INDEX IF NOT EXISTS idx_assets_user    ON assets(user_id, created_at);
		CREATE INDEX IF NOT EXISTS idx_assets_sweep   ON assets(purged_at, last_ref_at);
		CREATE INDEX IF NOT EXISTS idx_assets_type    ON assets(type, created_at);
		CREATE INDEX IF NOT EXISTS idx_assets_sha     ON assets(sha256);
	`);
	// 存量对象全在旧桶旧前缀 → 标 legacy 档（只跑一次；之后 WHERE 命中 0 行）
	db.exec("UPDATE assets SET storage = 'legacy' WHERE storage IS NULL");
}

// 预编译语句（复用，避免每次解析 SQL）
const COLS = "id, type, content_type, name, url, oss_key, duration_ms, created_at, storage, size_bytes, user_id, agent_id, sha256";
const stmtInsert = db.prepare(`INSERT INTO assets (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const stmtGet = db.prepare(`SELECT ${COLS} FROM assets WHERE id = ?`);
const stmtUpdateUrlKey = db.prepare("UPDATE assets SET url = ?, oss_key = ? WHERE id = ?");
// 自愈重传即复活（P3 起资产可能被清理打了墓碑）：清墓碑 + 刷引用时间。
// 不清墓碑的话 touchAssetRefs 会恒把它当死链回报 needHeal → 客户端每次打开项目都重传一遍，永不收敛。
const stmtHeal = db.prepare("UPDATE assets SET url = ?, oss_key = ?, purged_at = NULL, last_ref_at = ? WHERE id = ?");
const stmtSetDuration = db.prepare("UPDATE assets SET duration_ms = ? WHERE id = ?");
const stmtSeqUpdate = db.prepare("UPDATE asset_seqs SET seq = seq + 1 WHERE prefix = ?");
const stmtSeqInsert = db.prepare("INSERT OR IGNORE INTO asset_seqs (prefix, seq) VALUES (?, 1)");
const stmtSeqGet = db.prepare("SELECT seq FROM asset_seqs WHERE prefix = ?");
const stmtCount = db.prepare("SELECT COUNT(*) AS n FROM assets");

interface AssetRow {
	id: string;
	type: string;
	content_type: string;
	name: string | null;
	url: string;
	oss_key: string | null;
	duration_ms: number | null;
	created_at: string;
	storage: string | null;
	size_bytes: number | null;
	user_id: string | null;
	agent_id: string | null;
	sha256: string | null;
}
const rowToRec = (r: AssetRow): AssetRecord => ({
	id: r.id,
	type: r.type as Capability,
	contentType: r.content_type,
	name: r.name ?? undefined,
	url: r.url,
	ossKey: r.oss_key ?? undefined,
	durationMs: r.duration_ms ?? undefined,
	createdAt: r.created_at,
	storage: r.storage ?? undefined,
	sizeBytes: r.size_bytes ?? undefined,
	userId: r.user_id ?? undefined,
	agentId: r.agent_id ?? undefined,
	sha256: r.sha256 ?? undefined,
});

// 字节仅在内存（OSS 未配置时的 /raw 兜底；不落库）
const memBytes = new Map<string, Buffer>();

// ── OSS 转存失败降级 + 后台补传（2026-08-11）──
// 背景：上游已扣费出图后，管理端 → OSS 的 PUT 遇 ECONNRESET（"socket hang up"）成批失败，
// 一次上传失败就整单报废 = 图在服务端手里却丢单、用户积分白扣——与第158轮 fallbackUrl 防的是
// 同一种平台亏损，但 b64_json 路径没有上游直链可兜底，只能服务端自己兜。
// 做法：createAsset 上传失败（含一次 2s 退避重试后）→ 台账照落（url/oss_key 置空 → assetUrl
// 自动走 /raw、由 memBytes 供字节）+ 进补传队列；后台每 60s 顺序重试，成功即回写 url/oss_key
// （stmtUpdateUrlKey），公网直链自动恢复（/raw 此后 302 到直链，客户端已保存的 /raw 链接不受影响）。
// 边界：队列仅内存，重启即失 → /raw 404，由客户端死链自愈（reputAsset）兜底；
// 总量封顶 1GB，超出后不再降级、按原样抛错（防 OSS 长瘫把服务端内存吃爆）。
interface PendingOssUpload {
	ossKey: string;
	storageId: string;
	contentType: string;
	bytes: Buffer;
}
const pendingOss = new Map<string, PendingOssUpload>();
const PENDING_OSS_MAX_BYTES = 1024 * 1024 * 1024;
let pendingOssBytes = 0;

async function ossPutWithRetry(key: string, body: Buffer, contentType: string, profile: StorageProfile): Promise<string> {
	try {
		return await ossPut(key, body, contentType, profile);
	} catch {
		await new Promise((r) => setTimeout(r, 2000)); // SDK 自带 3 次连接重试仍失败 → 隔 2s 再整体试一次
		return ossPut(key, body, contentType, profile);
	}
}

let retryingOss = false;
/** 补传一轮：顺序重试队列（首个失败即收工——OSS 未恢复时不批量刷错）。定时器每 60s 调；导出供冒烟测试直接驱动 */
export async function retryPendingOssUploads(): Promise<void> {
	if (retryingOss || !pendingOss.size || !isOssConfigured()) return;
	retryingOss = true;
	try {
		let ok = 0;
		for (const [id, p] of [...pendingOss]) {
			try {
				const url = await ossPut(p.ossKey, p.bytes, p.contentType, profileOf(p.storageId));
				stmtUpdateUrlKey.run(url, p.ossKey, id);
				pendingOss.delete(id);
				pendingOssBytes -= p.bytes.length;
				memBytes.delete(id);
				ok++;
			} catch {
				break;
			}
		}
		if (ok) console.log(`[assets] OSS 补传成功 ${ok} 个，剩余 ${pendingOss.size} 个待补`);
	} finally {
		retryingOss = false;
	}
}
setInterval(() => void retryPendingOssUploads(), 60_000).unref();

// ── 首启一次性迁移旧 assets.json → SQLite（幂等：仅在 assets 表为空时导入） ──
(function migrateFromJson(): void {
	const legacyPath = join(DATA_DIR, LEGACY_FILE);
	if (!existsSync(legacyPath)) return;
	const count = (stmtCount.get() as { n: number } | undefined)?.n ?? 0;
	if (count > 0) return; // 已迁移过
	const legacy = loadJson<{ seqs?: Record<string, number>; records?: Record<string, AssetRecord> }>(LEGACY_FILE, {});
	const records = Object.values(legacy.records ?? {});
	const seqs = Object.entries(legacy.seqs ?? {});
	if (!records.length && !seqs.length) return;
	const tx = db.prepare("BEGIN"); // 用显式事务批量导入（一次提交，快且原子）
	tx.run();
	try {
		for (const r of records) {
			if (!r?.id) continue;
			// 旧 assets.json 的对象都在旧桶旧前缀 → storage='legacy'；size/归属留空由 reconcile 回填
			stmtInsert.run(r.id, r.type, r.contentType, r.name ?? null, r.url ?? "", r.ossKey ?? null, null, r.createdAt ?? new Date().toISOString(), "legacy", null, null, null, null);
		}
		const setSeq = db.prepare("INSERT INTO asset_seqs (prefix, seq) VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET seq = excluded.seq");
		for (const [prefix, seq] of seqs) setSeq.run(prefix, Number(seq) || 0);
		db.prepare("COMMIT").run();
	} catch (err) {
		db.prepare("ROLLBACK").run();
		throw err;
	}
	// 迁移成功：把旧文件改名留底，避免下次重复导入 / 混淆真理源
	try {
		renameSync(legacyPath, `${legacyPath}.migrated`);
	} catch {
		/* 改名失败无碍：表非空后 count>0 守卫已能防重复导入 */
	}
})();

/** 分配下一个 id：{prefix}{8位}，按前缀单调、永不复用（单线程内 UPDATE→INSERT→SELECT 原子） */
export function nextAssetId(prefix = "a"): string {
	const p = prefix || "a";
	if (stmtSeqUpdate.run(p).changes === 0) stmtSeqInsert.run(p); // 首见前缀：起始 1
	const seq = (stmtSeqGet.get(p) as { seq: number } | undefined)?.seq ?? 1;
	return `${p}${String(seq).padStart(8, "0")}`;
}

function extFor(contentType: string): string {
	const m: Record<string, string> = {
		"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
		"video/mp4": "mp4", "video/webm": "webm",
		"audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
		"text/plain": "txt", "text/plain; charset=utf-8": "txt",
	};
	return m[contentType] || m[contentType.split(";")[0].trim()] || "bin";
}

/** 资产元数据（按主键 id 索引查，微秒级） */
export function getAsset(id: string): AssetRecord | undefined {
	const r = stmtGet.get(id) as AssetRow | undefined;
	return r ? rowToRec(r) : undefined;
}
/** 内存字节（OSS 未配置时的 /raw 兜底） */
export function getAssetBytes(id: string): Buffer | undefined {
	return memBytes.get(id);
}
/** 回填视频时长缓存（第140轮：老资产首次计费探测后写回，之后按 id 直查零网络开销） */
export function setAssetDurationMs(id: string, ms: number): void {
	if (Number.isFinite(ms) && ms > 0) stmtSetDuration.run(Math.round(ms), id);
}

// 内容哈希去重（第224轮）：整桶按 sha256 查已有**存活且已上桶**的行，命中即复用其对象（不重复上传）。
// ⚠ 由此多行可共享同一物理对象——任何「删对象」动作（含将来重启清理）必须先查同 oss_key 的存活引用数。
const stmtBySha = db.prepare("SELECT id, url, oss_key, storage FROM assets WHERE sha256 = ? AND purged_at IS NULL AND oss_key IS NOT NULL AND url <> '' LIMIT 1");
/** 按内容哈希查可复用的已有对象（去重命中）。供 createAsset 与直传签发共用。 */
export function findAssetBySha(sha256: string): { id: string; url: string; ossKey: string; storage: string | null } | undefined {
	if (!sha256) return undefined;
	const r = stmtBySha.get(sha256) as { id: string; url: string; oss_key: string; storage: string | null } | undefined;
	return r ? { id: r.id, url: r.url, ossKey: r.oss_key, storage: r.storage } : undefined;
}
/** 同一物理对象（oss_key）的存活引用数——删除对象前必查（去重后多行共享对象，删 A 会弄裂 B） */
export function ossKeyRefCount(ossKey: string): number {
	return Number((db.prepare("SELECT COUNT(*) AS n FROM assets WHERE oss_key = ? AND purged_at IS NULL").get(ossKey) as { n: number }).n);
}

/**
 * 创建资产：分配类型前缀 id → 配置 OSS 则上传得公网直链；否则字节留内存。
 * 元数据 INSERT 进 SQLite（单条索引写，不重写整表）。
 * 对象键按 **active 存储档** 生成（acct 布局带归属账号目录段——第224轮）。
 * **内容去重**：sha256 命中已有存活对象 → 不上传，新行直接引用同一对象的 url/oss_key。
 * 归属（user_id/agent_id）从请求上下文自动取，见 runWithAssetOwner。
 */
export async function createAsset(
	data: Buffer,
	contentType: string,
	type: Capability,
	opts?: { prefix?: string; name?: string; owner?: AssetOwner },
): Promise<AssetRecord> {
	const id = nextAssetId(opts?.prefix);
	const profile = activeProfile();
	const createdAt = new Date().toISOString();
	const owner = opts?.owner ?? currentAssetOwner();
	const sha = createHash("sha256").update(data).digest("hex");
	const dup = isOssConfigured() ? findAssetBySha(sha) : undefined;
	const ossKey = dup ? dup.ossKey : keyFor(profile, { id, ext: extFor(contentType), type, createdAt, acct: acctSegmentOf(owner) });
	let url = dup ? dup.url : "";
	let uploaded = !!dup; // 去重命中=对象已在桶里
	if (isOssConfigured() && !dup) {
		try {
			url = await ossPutWithRetry(ossKey, data, contentType, profile);
			uploaded = true;
		} catch (err) {
			const msg = (err as Error).message;
			// 队列满 = 内存兜不动了，只能按原语义抛错整单失败（错因标明是 OSS 转存，别再让人误判成上游）
			if (pendingOssBytes + data.length > PENDING_OSS_MAX_BYTES) throw new Error(`转存 OSS 失败：${msg}`);
			memBytes.set(id, data);
			pendingOss.set(id, { ossKey, storageId: profile.id, contentType, bytes: data });
			pendingOssBytes += data.length;
			console.warn(`[assets] ${id} 转存 OSS 失败（${msg}），已降级 /raw + 进补传队列（待补 ${pendingOss.size} 个 / ${(pendingOssBytes / 1024 / 1024).toFixed(1)}MB）`);
		}
	} else if (!isOssConfigured()) {
		memBytes.set(id, data); // 兜底：无 OSS 时留内存供 /raw
	}
	// 视频入库顺手解析时长（字节在手零额外开销；mp4/mov 之外解析不出=null 不落）——参考视频按秒计费的缓存
	const durationMs = type === "video" || contentType.startsWith("video/") ? parseMp4DurationMs(data) : null;
	const rec: AssetRecord = {
		id,
		type,
		contentType,
		name: opts?.name,
		url,
		// ⚠ 只有真传上去了（或去重命中已在桶里）才落 oss_key：降级行若带 key，assetUrl 会按 key 拼出
		// 一条对象根本不存在的公网死链（而不是回退 /raw）；补传成功后由 stmtUpdateUrlKey 回写 url + oss_key。
		ossKey: uploaded ? ossKey : undefined,
		durationMs: durationMs ?? undefined,
		createdAt,
		storage: dup ? (dup.storage ?? undefined) : profile.id, // 去重行沿用对象所在档（删除定位一致）
		sizeBytes: data.length,
		userId: owner?.userId,
		agentId: owner?.agentId,
		sha256: sha,
	};
	stmtInsert.run(
		rec.id, rec.type, rec.contentType, rec.name ?? null, rec.url, rec.ossKey ?? null, rec.durationMs ?? null, rec.createdAt,
		rec.storage ?? null, rec.sizeBytes ?? null, rec.userId ?? null, rec.agentId ?? null, rec.sha256 ?? null,
	);
	return rec;
}

// ── 直传 OSS（第170轮）：预签名两段式 ──
// begin=分配 id+对象键（**不落台账**，供 routes 签发预签名 PUT URL）；客户端把字节直传 OSS 后
// complete=服务端校验对象真实存在（HEAD）才补登台账——台账里绝无"客户端声称传了、实际没传"的幽灵记录。
// pending 仅内存：服务端重启丢失=complete 失败，客户端回退 multipart 全量重传（孤儿对象无台账引用，无害）；
// id 由 nextAssetId 分配即消耗（id 永不复用的既有语义，弃用的 id 空洞无害）。
interface PendingDirect {
	id: string;
	ossKey: string;
	contentType: string;
	type: Capability;
	name?: string;
	expiresAt: number;
	/** 签发时的存储档 + 归属（complete 时照此落库，防中途改配置导致键与档不符） */
	storage: string;
	owner?: AssetOwner;
	createdAt: string;
}
const pendingDirect = new Map<string, PendingDirect>();
const PENDING_TTL_MS = 45 * 60_000; // 预签名 30 分钟 + 收尾余量

/** 直传第一段：分配 id/对象键并登记待确认会话（调用方须先判 isOssConfigured） */
export function beginDirectAsset(contentType: string, type: Capability, opts?: { prefix?: string; name?: string; owner?: AssetOwner }): PendingDirect {
	const now = Date.now();
	for (const [k, p] of pendingDirect) if (p.expiresAt < now) pendingDirect.delete(k); // 顺手清扫过期会话
	const id = nextAssetId(opts?.prefix);
	const profile = activeProfile();
	const createdAt = new Date().toISOString();
	const owner = opts?.owner ?? currentAssetOwner();
	const rec: PendingDirect = {
		id,
		ossKey: keyFor(profile, { id, ext: extFor(contentType), type, createdAt, acct: acctSegmentOf(owner) }),
		contentType,
		type,
		name: opts?.name,
		expiresAt: now + PENDING_TTL_MS,
		storage: profile.id,
		owner,
		createdAt,
	};
	pendingDirect.set(id, rec);
	return rec;
}

/** 直传第二段：HEAD 校验对象已在 OSS（403/405 → GET Range 兜底，同 isAssetAlive）→ 补登台账 */
export async function commitDirectAsset(
	id: string,
	maxBytes: number,
): Promise<{ ok: true; rec: AssetRecord } | { ok: false; error: string }> {
	const p = pendingDirect.get(id);
	if (!p || p.expiresAt < Date.now()) {
		pendingDirect.delete(id);
		return { ok: false, error: "直传会话不存在或已过期，请重新上传" };
	}
	const profile = profileOf(p.storage); // 按签发时的档解析，不受期间改配置影响
	const url = ossPublicUrl(p.ossKey, profile);
	let size = -1;
	try {
		const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10000) });
		if (r.ok) {
			size = Number(r.headers.get("content-length") ?? -1);
		} else if (r.status === 403 || r.status === 405) {
			const g = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(10000) });
			if (!g.ok && g.status !== 206) return { ok: false, error: `直传对象不可达（HTTP ${g.status}），请重新上传` };
			size = Number(g.headers.get("content-range")?.split("/")[1] ?? -1);
		} else {
			return { ok: false, error: `直传对象不可达（HTTP ${r.status}），请重新上传` };
		}
	} catch {
		return { ok: false, error: "直传对象校验失败（OSS 不可达），请重试" };
	}
	if (size > maxBytes) {
		void ossDelete(p.ossKey, profile); // 超限拒收：清掉已传对象，防绕过 multipart 体积上限
		pendingDirect.delete(id);
		return { ok: false, error: `文件超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）` };
	}
	pendingDirect.delete(id);
	// 视频时长不在此解析（字节不在服务端）——计费首用时经 probeRemoteDurationMs 探测并回填（第143轮既有路径）
	const rec: AssetRecord = {
		id: p.id,
		type: p.type,
		contentType: p.contentType,
		name: p.name,
		url,
		ossKey: p.ossKey,
		createdAt: p.createdAt,
		storage: p.storage,
		sizeBytes: size >= 0 ? size : undefined, // HEAD 拿到的真实字节数（客户端声称的不算数）
		userId: p.owner?.userId,
		agentId: p.owner?.agentId,
	};
	stmtInsert.run(
		rec.id, rec.type, rec.contentType, rec.name ?? null, rec.url, rec.ossKey ?? null, null, rec.createdAt,
		rec.storage ?? null, rec.sizeBytes ?? null, rec.userId ?? null, rec.agentId ?? null, null, // 直传字节不过服务端，不落客户端声称的哈希（去重只认服务端算过的）
	);
	return { ok: true, rec };
}

/**
 * 资产 OSS 直链是否可达（服务端自查——**在服务端 HEAD，绕开客户端 webview 的 CORS 限制**，
 * 判活可靠）。用于「死链自愈」：客户端据此决定是否要用本地副本重传修复。
 *  - 有 OSS url → HEAD 探活（部分 S3 兼容服务 HEAD 回 403/405 → GET Range 兜底）；
 *  - 无 url（未配 OSS 的降级模式）→ 内存字节还在算活。
 */
export async function isAssetAlive(id: string): Promise<boolean> {
	const rec = getAsset(id);
	if (!rec) return false;
	// 旧 OSS 桥接（第224轮）：命中旧基址=数据已整体舍弃，按死处理（省一次注定失败的外网探测），
	// 由客户端「检查素材/自愈」用本地副本走 reputAsset 桥接恢复到新 OSS。
	if (isBridgeOldUrl(rec.url)) return false;
	if (rec.url) {
		try {
			const r = await fetch(rec.url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
			if (r.ok) return true;
			if (r.status === 403 || r.status === 405) {
				const g = await fetch(rec.url, { method: "GET", headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(8000) });
				return g.ok || g.status === 206;
			}
			return false;
		} catch {
			return false; // 探测失败（含 DNS/超时）：保守当死链，由客户端本地副本重传兜底
		}
	}
	return memBytes.has(id);
}

/**
 * 死链自愈重传：用客户端提供的本地副本字节把资产字节重新写回。
 *  - **旧 OSS 桥接（第224轮）**：行的 url 指向已舍弃的旧桶 → 改传 **active 档（新 OSS）**，
 *    键 = `<恢复者账号>/<旧对象键路径>`（域名换、路径保形——「谁先恢复用谁的目录」；
 *    台账 url/oss_key 更新为新位置 → 之后所有人探活直接命中、复用同一份，不重复上传）。
 *  - 常规自愈：PUT 回**原对象键**（key 不变 → 公网直链不变 → 修复对所有引用生效）；
 *    ⚠ 按**该行自己的 storage 档**定位桶与键，不能用 active 档（写错桶=没修好还白占容量）。
 *  - 未配 OSS：写回内存兜底。
 * contentType 一律沿用台账既有值（不让调用方改类型）。资产不存在返回 undefined。
 */
export async function reputAsset(id: string, data: Buffer, opts?: { acct?: string }): Promise<AssetRecord | undefined> {
	const rec = getAsset(id);
	if (!rec) return undefined;
	const nowSec = Math.floor(Date.now() / 1000);
	if (isOssConfigured()) {
		const sha = createHash("sha256").update(data).digest("hex");
		if (isBridgeOldUrl(rec.url)) {
			// 桥接恢复：新 OSS + 账号目录 + 旧键路径。旧键为空（异常行）按旧布局推导兜底。
			const profile = activeProfile();
			const oldPath = (rec.ossKey || keyFor(profileOf(rec.storage), { id: rec.id, ext: extFor(rec.contentType), type: rec.type, createdAt: rec.createdAt })).replace(/^\/+/, "");
			const acct = sanitizeAcctSegment(opts?.acct) || acctSegmentOf({ userId: rec.userId }) || "anon";
			const newKey = `${acct}/${oldPath}`;
			const url = await ossPut(newKey, data, rec.contentType, profile);
			// 桥接行落新档 + 新键 + 哈希；缩略图还在旧桶=一并作废（客户端回退原图，后续自然重建）
			db.prepare("UPDATE assets SET url = ?, oss_key = ?, storage = ?, sha256 = ?, has_thumb = 0, purged_at = NULL, last_ref_at = ? WHERE id = ?")
				.run(url, newKey, profile.id, sha, nowSec, id);
			return { ...rec, url, ossKey: newKey, storage: profile.id, sha256: sha };
		}
		const { profile, key: ossKey, url: derivedUrl } = locate({ ...rec, type: rec.type }, extFor(rec.contentType));
		const url = await ossPut(ossKey, data, rec.contentType, profile);
		stmtHeal.run(url || derivedUrl, ossKey, nowSec, id); // 顺带清墓碑（被清理过的行自愈即复活）
		return { ...rec, url, ossKey };
	}
	memBytes.set(id, data);
	stmtHeal.run(rec.url, rec.ossKey ?? null, nowSec, id);
	return rec;
}

// ── 缩略图（P1）──
// 素材库/收藏墙一屏几十张图，直接引原图＝几十 MB 流量还慢。客户端生成 256px WebP
// 直传到 `thumb/` 前缀（独立前缀便于单独挂 lifecycle、也便于将来整批重建）。
// 服务端只做两件事：给对象键 + 记 has_thumb —— **缩略图不进 assets 台账**
// （它是原图的附属品，不是独立资产：没有独立 id、不参与配额、原图删了它跟着按前缀规则走）。
const stmtSetThumb = db.prepare("UPDATE assets SET has_thumb = ? WHERE id = ?");

/** 缩略图对象键：与原图同档，固定 webp */
export function thumbKeyOf(id: string): string {
	return `thumb/${id}.webp`;
}
/** 标记缩略图已生成/已失效 */
export function setAssetThumb(id: string, has: boolean): void {
	stmtSetThumb.run(has ? 1 : 0, id);
}
/** 缩略图公网直链（has_thumb 为真时才有意义；调用方自行判断，本函数不查库） */
export function thumbUrlOf(rec: { id: string; storage?: string }): string {
	return ossPublicUrl(thumbKeyOf(rec.id), profileOf(rec.storage));
}

// ── 引用上报（P1）──
// 保留规则的核心输入：一个资产「最后一次被真实使用」是什么时候。
// 客户端在**打开项目**与**保存项目**时把该项目引用到的 assetId 批量报上来，
// 服务端只刷 last_ref_at，不做别的。
// 设计要点：
//  - **幂等且极廉价**：一条 UPDATE ... WHERE id IN (...)，走主键，几千个 id 也是毫秒级；
//  - **绝不复活墓碑**：purged_at 非空的行不刷（对象已经不在了，刷了会让统计撒谎）；
//    但会把它们回报给客户端——客户端据此知道该拿本地副本走死链自愈（reputAsset）；
//  - **不鉴权到资产粒度**：报别人的 id 只会让那个资产多活一阵，没有信息泄漏也无利可图，
//    为此引入逐条归属校验（几千次查询）不划算。上限 2000 个/次防滥用。
const REF_BATCH_MAX = 2000;

/** 批量刷新引用时间。返回实际刷新数 + 需要自愈的 id（已打墓碑或台账里没有） */
export function touchAssetRefs(ids: string[], at = Math.floor(Date.now() / 1000)): { updated: number; needHeal: string[] } {
	const uniq = [...new Set(ids.filter((s) => typeof s === "string" && s))].slice(0, REF_BATCH_MAX);
	if (!uniq.length) return { updated: 0, needHeal: [] };
	const ph = uniq.map(() => "?").join(",");
	// 先查出这批里「活着的」，差集即需要自愈的（一次查询搞定，不逐条 getAsset）
	const alive = new Set(
		(db.prepare(`SELECT id FROM assets WHERE purged_at IS NULL AND id IN (${ph})`).all(...uniq) as { id: string }[]).map((r) => r.id),
	);
	const r = db.prepare(`UPDATE assets SET last_ref_at = ? WHERE purged_at IS NULL AND id IN (${ph})`).run(at, ...uniq);
	return { updated: Number(r.changes), needHeal: uniq.filter((id) => !alive.has(id)) };
}

// ── 容量统计（P0，管理端「存储」页）──
// 全部是 SQLite 聚合，走 idx_assets_type / idx_assets_user / idx_assets_created 索引，
// **不碰 OSS**（不发一个网络请求）——页面秒开，可随时刷新。
// 口径：一律只统计**存活行**（purged_at IS NULL）；墓碑行单列一个数。
// ⚠ size_bytes 为空的行不计入字节数——存量需先跑 scripts/reconcile.mjs 回填，
//   故一并返回 unsized 计数，页面据此提示「统计不完整」。

export interface StorageBucketStat {
	key: string;
	label?: string;
	n: number;
	bytes: number;
}
export interface StorageStats {
	rows: number;
	live: number;
	purged: number;
	bytes: number;
	purgedBytes: number;
	unsized: number;
	/** 旧桶遗留（第226轮：旧 OSS 整体舍弃）：链接仍指旧基址的存活行——不计入上面的占用，
	 *  等用户桥接恢复/迁移脚本搬运后逐步归零 */
	bridgeCount: number;
	bridgeBytes: number;
	byType: StorageBucketStat[];
	byMonth: StorageBucketStat[];
	byUser: StorageBucketStat[];
	byAgent: StorageBucketStat[];
	byStorage: StorageBucketStat[];
	byAge: StorageBucketStat[];
}

const scalar = (sql: string): number => Number((db.prepare(sql).get() as Record<string, unknown>)?.v ?? 0);
const group = (sql: string): StorageBucketStat[] =>
	(db.prepare(sql).all() as { k: string | null; n: number; b: number }[]).map((r) => ({ key: r.k ?? "", n: Number(r.n), bytes: Number(r.b) }));

/** 容量统计快照；nameOf 用于把 user_id/agent_id 换成人读名字（调用方注入，避免 store 互相依赖）。
 *  第226轮起口径=**只统计我们在管的新 OSS**：链接仍指旧基址的行（旧桶数据已整体舍弃）单列
 *  bridgeCount/bridgeBytes，不混进占用容量与各分布表。 */
export function storageStats(nameOf?: { user?: (id: string) => string | undefined; agent?: (id: string) => string | undefined }): StorageStats {
	const NOT_OLD = notOldUrlCondSql();
	const LIVE = `purged_at IS NULL AND ${NOT_OLD}`;
	const OLD_LIVE = `purged_at IS NULL AND NOT (${NOT_OLD})`;
	const stats: StorageStats = {
		rows: scalar("SELECT COUNT(*) AS v FROM assets"),
		live: scalar(`SELECT COUNT(*) AS v FROM assets WHERE ${LIVE}`),
		purged: scalar("SELECT COUNT(*) AS v FROM assets WHERE purged_at IS NOT NULL"),
		bytes: scalar(`SELECT COALESCE(SUM(size_bytes),0) AS v FROM assets WHERE ${LIVE}`),
		purgedBytes: scalar("SELECT COALESCE(SUM(size_bytes),0) AS v FROM assets WHERE purged_at IS NOT NULL"),
		unsized: scalar(`SELECT COUNT(*) AS v FROM assets WHERE ${LIVE} AND size_bytes IS NULL AND oss_key IS NOT NULL AND oss_key <> ''`),
		bridgeCount: scalar(`SELECT COUNT(*) AS v FROM assets WHERE ${OLD_LIVE}`),
		bridgeBytes: scalar(`SELECT COALESCE(SUM(size_bytes),0) AS v FROM assets WHERE ${OLD_LIVE}`),
		byType: group(`SELECT type AS k, COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM assets WHERE ${LIVE} GROUP BY type ORDER BY b DESC`),
		// created_at 是 ISO 串，前 7 位即 YYYY-MM（字典序=时间序）
		byMonth: group(`SELECT substr(created_at,1,7) AS k, COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM assets WHERE ${LIVE} GROUP BY k ORDER BY k DESC LIMIT 12`),
		byUser: group(`SELECT COALESCE(user_id,'') AS k, COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM assets WHERE ${LIVE} GROUP BY k ORDER BY b DESC LIMIT 20`),
		byAgent: group(`SELECT COALESCE(agent_id,'') AS k, COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM assets WHERE ${LIVE} GROUP BY k ORDER BY b DESC LIMIT 20`),
		byStorage: group(`SELECT COALESCE(storage,'legacy') AS k, COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM assets WHERE ${LIVE} GROUP BY k ORDER BY b DESC`),
		byAge: group(
			`SELECT CASE
				WHEN created_at >= datetime('now','-7 days')  THEN '0:7 天内'
				WHEN created_at >= datetime('now','-14 days') THEN '1:7-14 天'
				WHEN created_at >= datetime('now','-30 days') THEN '2:14-30 天'
				WHEN created_at >= datetime('now','-90 days') THEN '3:30-90 天'
				ELSE '4:90 天以上' END AS k,
				COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b
			 FROM assets WHERE ${LIVE} GROUP BY k ORDER BY k`,
		),
	};
	for (const r of stats.byUser) r.label = r.key ? nameOf?.user?.(r.key) : "（无归属）";
	for (const r of stats.byAgent) r.label = r.key ? nameOf?.agent?.(r.key) : "（源站直属）";
	for (const r of stats.byAge) {
		r.label = r.key.slice(2); // 排序前缀 "0:" 只为 ORDER BY，展示时去掉
		r.key = r.label;
	}
	return stats;
}

/** 资产可访问 url：优先 OSS 直链；否则回退服务端 /raw（凭 id 重解析） */
export function assetUrl(baseUrl: string, id: string): string {
	const rec = getAsset(id);
	if (rec?.url) return rec.url; // 存的 url 永远优先：换布局后老对象照常可访问
	if (rec?.ossKey) return ossPublicUrl(rec.ossKey, profileOf(rec.storage));
	return `${baseUrl.replace(/\/+$/, "")}/v1/assets/${id}/raw`;
}
