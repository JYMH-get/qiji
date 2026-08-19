/**
 * 保留策略与清理预览——**只算不删**。
 *
 * ⚠ 本模块**没有任何删除能力**，这是有意的（P2 观察期的约束延续到今天）：
 *   真正的删除动作在 cleanup.ts（P3，第223轮上线），且两边共用同一份候选查询
 *   （listSweepCandidates）——「预览说会删什么」与「清理真删什么」永远一致，
 *   不会出现两处各写一份 SQL 然后悄悄漂移的分叉。
 *
 * 保留规则（方案 §4.2，天数全部可配）：
 *   有收藏（用户或平台）        → 永久保留
 *   共享素材库里的素材          → 永久保留
 *   被引用过（last_ref_at 有值）→ last_ref_at + refDays
 *   从未被引用                  → created_at   + unrefDays
 *   TP 临时前缀                 → 走 tmpDays（比正式资产更短）
 *
 * ⚠ **类型陷阱**：`last_ref_at` / `purged_at` 是 INTEGER（epoch 秒），
 *   但 `created_at` 是 **TEXT ISO 串**。两者不能混着比 ——
 *   写成 `created_at < :now - N*86400` 会恒为 false（字符串 vs 数字），
 *   结果是「从未引用」那一整档静默一个都清不掉，且不报错。
 *   故 created_at 一律与 **ISO 串**比较（字典序即时间序，还能走 idx_assets_created）。
 */
import { db } from "./sqlite.ts";
import { loadJson, saveJson } from "./db.ts";
import { listSharedAssetIds } from "./sharedLibs.ts";
import { isBridgeOldUrl, notOldUrlCondSql } from "./assets.ts";

export interface RetentionDays {
	/** TP 临时资产（垫图中间产物等） */
	tmp: number;
	/** 正式资产但从未被任何项目引用过 */
	unref: number;
	/** 被引用过的正式资产，从最后一次引用起算 */
	ref: number;
}

const FILE = "settings.json";
const DEFAULTS: RetentionDays = { tmp: 7, unref: 7, ref: 14 };

interface RetentionSettings {
	retentionDays?: Partial<RetentionDays>;
}

/** 现读 settings.json（低频路径：只在管理端看预览/改配置时走） */
export function getRetentionDays(): RetentionDays {
	const s = loadJson<RetentionSettings>(FILE, {}).retentionDays ?? {};
	const pick = (v: unknown, d: number) => {
		const n = Math.floor(Number(v) || 0);
		return n >= 1 ? Math.min(n, 3650) : d; // 1 天 ~ 10 年
	};
	return { tmp: pick(s.tmp, DEFAULTS.tmp), unref: pick(s.unref, DEFAULTS.unref), ref: pick(s.ref, DEFAULTS.ref) };
}

export function setRetentionDays(patch: Partial<RetentionDays>): RetentionDays {
	const all = loadJson<Record<string, unknown>>(FILE, {});
	all.retentionDays = { ...getRetentionDays(), ...patch };
	saveJson(FILE, all);
	return getRetentionDays();
}

/** 一条待清理候选（预览与清理执行共用） */
export interface SweepCandidate {
	id: string;
	type: string;
	sizeBytes: number;
	createdAt: string;
	lastRefAt: number | null;
	/** 命中哪一档 */
	band: "tmp" | "unref" | "ref";
	/** 以下三列供清理执行定位对象（预览不显示） */
	ossKey: string | null;
	storage: string | null;
	hasThumb: boolean;
}

/** 豁免集合：任何人收藏的（含平台收藏）+ 共享素材库里的 —— 永久保留 */
export function exemptSets(): { favIds: Set<string>; sharedIds: Set<string> } {
	const favIds = new Set(
		(db.prepare("SELECT DISTINCT asset_id FROM favorites").all() as { asset_id: string }[]).map((r) => r.asset_id),
	);
	const sharedIds = new Set(listSharedAssetIds());
	return { favIds, sharedIds };
}

/**
 * 按当前策略列出全部待清理候选（**纯只读**，豁免已剔除，按 created_at 从旧到新）。
 * 预览（sweepPreview）与清理执行（cleanup.ts）都从这里取——单一事实来源。
 *
 * ⚠ TP 必须在 SQL 里就用**自己的** tmp 天数筛，不能先按 unref/ref 粗筛再复核：
 *   tmp 的用途是让临时资产活得**更短**，若粗筛用 unref，则 tmp < unref 时
 *   处在两者之间的 TP 永远进不了候选 —— tmp 调小静默无效（只能调大），与设计意图相反。
 * ⚠ 旧桶行不进候选（第226轮）：旧 OSS 整体舍弃后「原 OSS 我们不管了」——那些行的生命周期
 *   由桥接恢复语义管理（用户恢复即迁新桶），清理既删不到旧桶对象、打了墓碑还碍着统计，一律跳过。
 */
export function listSweepCandidates(): SweepCandidate[] {
	const days = getRetentionDays();
	const now = Math.floor(Date.now() / 1000);
	const isoAgo = (d: number) => new Date((now - d * 86400) * 1000).toISOString();
	const { favIds, sharedIds } = exemptSets();
	const rows = db
		.prepare(
			`SELECT id, type, COALESCE(size_bytes,0) AS size_bytes, created_at, last_ref_at,
			        oss_key, storage, COALESCE(has_thumb,0) AS has_thumb, url
			 FROM assets
			 WHERE purged_at IS NULL
			   AND CASE WHEN id LIKE 'TP%'
			        THEN (last_ref_at IS NOT NULL AND last_ref_at < ?) OR (last_ref_at IS NULL AND created_at < ?)
			        ELSE (last_ref_at IS NOT NULL AND last_ref_at < ?) OR (last_ref_at IS NULL AND created_at < ?)
			       END
			 ORDER BY created_at`,
		)
		.all(
			now - days.tmp * 86400, isoAgo(days.tmp),      // TP：引用后与未引用都按 tmp
			now - days.ref * 86400, isoAgo(days.unref),    // 正式资产：ref / unref
		) as { id: string; type: string; size_bytes: number; created_at: string; last_ref_at: number | null; oss_key: string | null; storage: string | null; has_thumb: number; url: string }[];
	const out: SweepCandidate[] = [];
	for (const r of rows) {
		if (favIds.has(r.id) || sharedIds.has(r.id)) continue; // 永久保留，不进候选
		if (isBridgeOldUrl(r.url)) continue; // 旧桶遗留：不归清理管（见函数头注释）
		const isTmp = /^TP\d/.test(r.id);
		out.push({
			id: r.id,
			type: r.type,
			sizeBytes: Number(r.size_bytes) || 0,
			createdAt: r.created_at,
			lastRefAt: r.last_ref_at,
			band: isTmp ? "tmp" : r.last_ref_at != null ? "ref" : "unref",
			ossKey: r.oss_key,
			storage: r.storage,
			hasThumb: !!r.has_thumb,
		});
	}
	return out;
}

export interface SweepPreview {
	/** 计算时刻（epoch 秒） */
	at: number;
	days: RetentionDays;
	/** 各档命中数与字节数 */
	bands: { band: string; label: string; count: number; bytes: number }[];
	totalCount: number;
	totalBytes: number;
	/** 因收藏/共享库而被豁免的数量（让运营看得见「保护网起作用了」） */
	protectedByFavorite: number;
	protectedByShared: number;
	/** 存活总量，用于算占比 */
	liveCount: number;
	liveBytes: number;
	/** 抽样（各档前若干条），供人工核对合理性 */
	samples: SweepCandidate[];
	/** 还有多少存活行没有 size_bytes —— 有的话总字节数是低估的 */
	unsized: number;
}

const BAND_LABEL: Record<string, string> = {
	tmp: "临时资产（TP）",
	unref: "从未被引用",
	ref: "被引用过但已超期",
};

/**
 * 算一遍「按当前策略现在会清掉什么」。**纯只读**。
 *
 * 实现说明：候选来自 listSweepCandidates（与清理执行同一条查询）；
 * 收藏与共享库的豁免集合在 JS 侧组装成 Set 统一剔除——
 * 收藏表在同一个库里本可 JOIN，但共享库素材来自 sharedLibs.json（不在 SQLite 里），
 * 两边都用同一条路径处理，逻辑只有一份，不会出现「SQL 豁免了、JS 没豁免」的分叉。
 */
export function sweepPreview(opts?: { sampleLimit?: number }): SweepPreview {
	const days = getRetentionDays();
	const now = Math.floor(Date.now() / 1000);
	const { favIds, sharedIds } = exemptSets();

	const bands: Record<string, { count: number; bytes: number }> = { tmp: { count: 0, bytes: 0 }, unref: { count: 0, bytes: 0 }, ref: { count: 0, bytes: 0 } };
	const samples: SweepCandidate[] = [];
	const sampleLimit = opts?.sampleLimit ?? 10;
	const sampleCount: Record<string, number> = { tmp: 0, unref: 0, ref: 0 };
	for (const r of listSweepCandidates()) {
		bands[r.band].count += 1;
		bands[r.band].bytes += r.sizeBytes;
		if (sampleCount[r.band] < sampleLimit) {
			sampleCount[r.band] += 1;
			samples.push(r);
		}
	}

	// 「因收藏/共享库受保护」= 有多少**存活素材因此永久保留**，独立于候选集统计。
	// ⚠ 不能在候选循环里数：addFavorite 会把 last_ref_at 刷成当下，被收藏的素材根本进不了候选，
	//   在循环里数出来恒为 0（沙盒实测踩到）。运营想看的是「永久保留了多少」，不是「差点被删多少」。
	const countLive = (ids: Set<string>): number => {
		if (!ids.size) return 0;
		let n = 0;
		const arr = [...ids];
		for (let i = 0; i < arr.length; i += 900) {
			const chunk = arr.slice(i, i + 900); // SQLite 变量数上限（默认 999），分批查
			const ph = chunk.map(() => "?").join(",");
			n += Number((db.prepare(`SELECT COUNT(*) AS n FROM assets WHERE purged_at IS NULL AND id IN (${ph})`).get(...chunk) as { n: number }).n);
		}
		return n;
	};
	const protectedByFavorite = countLive(favIds);
	const protectedByShared = countLive(sharedIds);

	// 存活分母与「未回填体积」计数同用新 OSS 口径（旧桶遗留不计——与候选口径、容量总览一致）
	const NOT_OLD = notOldUrlCondSql();
	const live = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM assets WHERE purged_at IS NULL AND ${NOT_OLD}`).get() as { n: number; b: number };
	const unsized = Number(
		(db.prepare(`SELECT COUNT(*) AS n FROM assets WHERE purged_at IS NULL AND ${NOT_OLD} AND size_bytes IS NULL AND oss_key IS NOT NULL AND oss_key <> ''`).get() as { n: number }).n,
	);

	const bandList = (["tmp", "unref", "ref"] as const).map((b) => ({ band: b, label: BAND_LABEL[b], count: bands[b].count, bytes: bands[b].bytes }));
	return {
		at: now,
		days,
		bands: bandList,
		totalCount: bandList.reduce((s, b) => s + b.count, 0),
		totalBytes: bandList.reduce((s, b) => s + b.bytes, 0),
		protectedByFavorite,
		protectedByShared,
		liveCount: Number(live.n),
		liveBytes: Number(live.b),
		samples,
		unsized,
	};
}
