/**
 * P3 清理执行（第223轮）——保留策略「动手」的一半；retention.ts（只算）之外唯一的删除入口。
 *
 * 清理语义（方案 §10-P3，勿改）：
 *   清理 = ossDeleteStrict（删失败=该行**不打墓碑**，下轮重试） + 台账行打 purged_at 墓碑；
 *   **台账行永不删**——reputAsset 死链自愈、引用上报 needHeal 都依赖行存在（§4.4 硬性约束）。
 *   url/oss_key 也保留：客户端拿本地副本自愈时要 PUT 回原键，直链才对所有存量引用继续有效。
 *
 * 三道闸门（都是配置，随时可中止）：
 *   mode  off（默认；部署后不动=什么都不发生）/ dry（试运行：只记报告，一个不删）/ on（真删）
 *   scope tmp（首批：只清 TP 临时资产——方案 §9「先只清 tmp、观察无投诉再动正式资产」）/ all（第二批）
 *   每轮最多 SWEEP_BATCH 个、每小时一轮——「不要一次删 400GB」在执行层的兜底。
 *
 * 存量特赦（方案 §9）：mode 首次离开 off 时自动执行一次——
 *   把全部「从未被引用」的**正式**资产 last_ref_at 设为当下（全体落入「被引用」档，30 天内不动存量），
 *   并把 ref 档临时抬到 30 天（原值记入 refBefore；满 30 天后运营在管理端手动调回）。
 *   ⚠ TP 刻意不特赦——临时资产（垫图中间产物）就是首批要清的对象，特赦它=首批空转 7 天；
 *     被项目真实引用过的 TP 有 last_ref_at 滚动续期 + 客户端本地副本自愈兜底。
 */
import { db } from "./sqlite.ts";
import { loadJson, saveJson } from "./db.ts";
import { isOssConfigured, ossDelete, ossDeleteStrict } from "./oss.ts";
import { profileOf } from "./storage.ts";
import { thumbKeyOf, ossKeyRefCount } from "./assets.ts";
import { getRetentionDays, setRetentionDays, listSweepCandidates } from "./retention.ts";

export type CleanupMode = "off" | "dry" | "on";
export type CleanupScope = "tmp" | "all";

interface CleanupState {
	mode: CleanupMode;
	scope: CleanupScope;
	/** 存量特赦执行时刻（epoch 秒）；有值=已执行过，永不重跑 */
	amnestyAt?: number;
	/** 特赦覆盖的行数（记档供核对） */
	amnestyTouched?: number;
	/** 特赦前的 ref 档天数（满 30 天后运营手动调回的目标值） */
	refBefore?: number;
}

// ⚠ 状态放独立文件、不进 settings.json：settings.ts 持有启动时快照整体落盘，
// 启动后写进 settings.json 的新键有被旧快照抹掉的风险（mode/amnestyAt 丢了=清理静默关闭、
// 特赦记录丢失）。独立文件只有本模块读写，天然无此冲突。
const STATE_FILE = "cleanup.json";
const REPORT_FILE = "cleanup-report.json";
/** 每轮删除上限（每小时一轮 ≈ 4.8 万/天，几天清完存量 TP，不会一口气清空） */
const SWEEP_BATCH = 2000;
const REPORT_KEEP = 40;
const DELETE_CONCURRENCY = 8;

export function getCleanupState(): CleanupState {
	const raw = loadJson<Partial<CleanupState>>(STATE_FILE, {});
	const mode: CleanupMode = raw.mode === "dry" || raw.mode === "on" ? raw.mode : "off";
	const scope: CleanupScope = raw.scope === "all" ? "all" : "tmp";
	return {
		mode,
		scope,
		amnestyAt: typeof raw.amnestyAt === "number" ? raw.amnestyAt : undefined,
		amnestyTouched: typeof raw.amnestyTouched === "number" ? raw.amnestyTouched : undefined,
		refBefore: typeof raw.refBefore === "number" ? raw.refBefore : undefined,
	};
}

function saveCleanupState(next: CleanupState): void {
	saveJson(STATE_FILE, next);
}

/** 存量特赦（幂等：amnestyAt 有值即不再跑） */
function runStockAmnesty(cur: CleanupState): CleanupState {
	const now = Math.floor(Date.now() / 1000);
	// ⚠ 只动「从未被引用」的行——已有真实 last_ref_at 的一律保留真实数据（比特赦日更准）
	const r = db
		.prepare("UPDATE assets SET last_ref_at = ? WHERE purged_at IS NULL AND last_ref_at IS NULL AND id NOT LIKE 'TP%'")
		.run(now);
	const next: CleanupState = { ...cur, amnestyAt: now, amnestyTouched: Number(r.changes) };
	const days = getRetentionDays();
	if (days.ref < 30) {
		next.refBefore = days.ref;
		setRetentionDays({ ref: 30 }); // 特赦期：被引用档临时 30 天，满月后运营调回 refBefore
	}
	console.log(`[cleanup] 存量特赦：${r.changes} 条正式资产 last_ref_at=特赦日；ref 档 ${days.ref < 30 ? `${days.ref}→30 天（满 30 天后请调回）` : `${days.ref} 天（已 ≥30，未动）`}`);
	return next;
}

export function setCleanupConfig(patch: { mode?: unknown; scope?: unknown }): { ok: true; amnestyJustRan: boolean } | { ok: false; error: string } {
	const cur = getCleanupState();
	const mode = patch.mode === undefined ? cur.mode : patch.mode;
	const scope = patch.scope === undefined ? cur.scope : patch.scope;
	if (mode !== "off" && mode !== "dry" && mode !== "on") return { ok: false, error: "mode 须为 off / dry / on" };
	if (scope !== "tmp" && scope !== "all") return { ok: false, error: "scope 须为 tmp / all" };
	let next: CleanupState = { ...cur, mode, scope };
	let amnestyJustRan = false;
	if (mode !== "off" && !cur.amnestyAt) {
		next = runStockAmnesty(next); // 首次开闸（含试运行）即特赦——试运行的报告才反映真实口径，且存量保护钟从今天起算
		amnestyJustRan = true;
	}
	saveCleanupState(next);
	return { ok: true, amnestyJustRan };
}

export interface CleanupRunReport {
	at: number;
	mode: CleanupMode | "dry"; // off 手动触发按 dry 预演
	scope: CleanupScope;
	trigger: "timer" | "manual";
	/** 范围内候选总数（含超出本轮上限的） */
	candidates: number;
	/** 因 scope=tmp 被跳过的正式资产候选数（第二批才动） */
	outOfScope: number;
	/** 本轮实际处理（≤ SWEEP_BATCH）；dry=将删数 */
	attempted: number;
	deleted: number;
	failed: number;
	/** 无对象键的行（降级 /raw 行等：无对象可删，直接打墓碑） */
	noKey: number;
	/** on=已释放字节；dry=本轮将释放字节 */
	bytes: number;
	byBand: Record<string, { count: number; bytes: number }>;
	sampleIds: string[];
	tookMs: number;
	note?: string;
}

function loadReports(): CleanupRunReport[] {
	return loadJson<CleanupRunReport[]>(REPORT_FILE, []);
}
function pushReport(r: CleanupRunReport): void {
	const all = loadReports();
	all.push(r);
	saveJson(REPORT_FILE, all.slice(-REPORT_KEEP));
}

let running = false;

/**
 * 执行一轮清理。timer 触发时 mode=off 直接跳过（返回 null）；
 * manual 触发时 mode=off/dry 都按试运行预演（只算不删），mode=on 真删。
 */
export async function runCleanupOnce(trigger: "timer" | "manual"): Promise<CleanupRunReport | null> {
	const cfg = getCleanupState();
	if (trigger === "timer" && cfg.mode === "off") return null;
	if (running) return null; // 防重入（上一轮 OSS 慢时定时器可能追上来）
	running = true;
	const t0 = Date.now();
	try {
		const effMode: "dry" | "on" = cfg.mode === "on" ? "on" : "dry";
		const all = listSweepCandidates();
		const inScope = cfg.scope === "tmp" ? all.filter((r) => r.band === "tmp") : all;
		const batch = inScope.slice(0, SWEEP_BATCH); // 已按 created_at 从旧到新——最老的先走
		const byBand: Record<string, { count: number; bytes: number }> = {};
		for (const r of inScope) {
			const b = (byBand[r.band] ??= { count: 0, bytes: 0 });
			b.count += 1;
			b.bytes += r.sizeBytes;
		}
		let deleted = 0, failed = 0, noKey = 0, bytes = 0;
		let note: string | undefined;
		if (effMode === "on") {
			const stmtPurge = db.prepare("UPDATE assets SET purged_at = ?, has_thumb = 0 WHERE id = ?");
			const nowSec = Math.floor(Date.now() / 1000);
			const ossUp = isOssConfigured();
			let i = 0;
			const worker = async (): Promise<void> => {
				while (i < batch.length) {
					const r = batch[i++];
					try {
						if (r.ossKey) {
							if (!ossUp) { failed += 1; continue; } // OSS 未配置删不了对象：不打墓碑，恢复配置后下轮重试
							// ⚠ 去重护栏（第224轮起 sha256 去重=多行可共享同一物理对象）：还有别的存活行引用
							//   同一 oss_key 时**只打墓碑不删对象**——删了会把别人的引用弄裂。
							if (ossKeyRefCount(r.ossKey) <= 1) {
								const profile = profileOf(r.storage); // ⚠ 按该行自己的档定位——用 active 档会删到新桶上
								await ossDeleteStrict(r.ossKey, profile);
								if (r.hasThumb) void ossDelete(thumbKeyOf(r.id), profile); // 缩略图 best-effort：主对象已删，孤儿缩略图无引用无害
							}
						} else {
							noKey += 1; // 无对象可删（降级 /raw 行）：直接打墓碑
						}
						stmtPurge.run(nowSec, r.id);
						deleted += 1;
						bytes += r.sizeBytes;
					} catch {
						failed += 1; // 删失败不打墓碑，下轮重试（墓碑撒谎=对象还在桶里占容量却从统计里消失）
					}
				}
			};
			await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, worker));
		} else {
			bytes = batch.reduce((s, r) => s + r.sizeBytes, 0);
			note = cfg.mode === "off" ? "模式为「关闭」，本轮按试运行预演（未删除任何对象）" : "试运行：未删除任何对象";
		}
		const report: CleanupRunReport = {
			at: Math.floor(Date.now() / 1000),
			mode: effMode,
			scope: cfg.scope,
			trigger,
			candidates: inScope.length,
			outOfScope: all.length - inScope.length,
			attempted: batch.length,
			deleted,
			failed,
			noKey,
			bytes,
			byBand,
			sampleIds: batch.slice(0, 20).map((r) => r.id),
			tookMs: Date.now() - t0,
			note,
		};
		pushReport(report);
		if (effMode === "on" && (deleted || failed)) {
			console.log(`[cleanup] 本轮清理 ${deleted} 个（${(bytes / 1048576).toFixed(1)}MB）${failed ? `，失败 ${failed}（下轮重试）` : ""}，范围内剩余 ${inScope.length - deleted}`);
		}
		return report;
	} finally {
		running = false;
	}
}

/** 管理端总览：配置 + 特赦状态 + 最近执行记录（新在前） */
export function cleanupOverview() {
	const cfg = getCleanupState();
	return {
		config: { mode: cfg.mode, scope: cfg.scope },
		amnestyAt: cfg.amnestyAt ?? null,
		amnestyTouched: cfg.amnestyTouched ?? 0,
		refBefore: cfg.refBefore ?? null,
		days: getRetentionDays(),
		runs: loadReports().slice(-12).reverse(),
	};
}

/** 定时清理：启动 5 分钟后首轮（避开启动对账/VACUUM），此后每小时一轮。仅源站调用（relay 无资产）。 */
export function startCleanupLoop(log?: { info: (msg: string) => void }): void {
	const tick = async (): Promise<void> => {
		try {
			const rep = await runCleanupOnce("timer");
			if (rep && rep.mode === "on" && rep.deleted) {
				log?.info(`[cleanup] 清理 ${rep.deleted} 个 / ${(rep.bytes / 1048576).toFixed(1)}MB（失败 ${rep.failed}，范围内候选 ${rep.candidates}）`);
			}
		} catch (err) {
			console.warn("[cleanup] 本轮清理异常（不影响服务）：", (err as Error).message);
		}
	};
	setTimeout(() => void tick(), 5 * 60_000).unref();
	setInterval(() => void tick(), 3600_000).unref();
}
