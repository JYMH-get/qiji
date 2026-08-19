/**
 * 收藏与配额（P1）——「哪些素材要永久保留，以及一个人/一个团能永久保留多少」。
 *
 * 语义（方案 §5.3/§5.4，逐条对应）：
 *  - **多人收藏取并集**：只要还有一条 favorites 记录，该资产就永久保留；
 *  - **平台收藏优先级最高**：用户全取消了，只要平台（管理端二次收藏/审核）还收着就保留；
 *  - **取消收藏绝不立即删**：一律把 last_ref_at 刷成当下，转入「被引用 +N 天」倒计时；
 *  - **删用户级联删其收藏**：若该资产再无人收藏，同样走倒计时，不立即删；
 *  - **用量实时 SUM**（favorites JOIN assets），不做计数器 —— 计数器不同步是经典 bug，
 *    而十万行带索引求和是微秒级；
 *  - **配额的本质是「永久保留额度」，不是「存不下」**：超额只挡新增收藏，
 *    用户照常生成、照常使用，提示语必须是「收藏空间已满」而不是「存储失败」。
 *
 * 生效配额 = 基础配额（全局默认，可按用户/按团覆盖）+ SUM(未过期的 quota_grants)。
 */
import { db } from "./sqlite.ts";
import { genId } from "./db.ts";

export type OwnerType = "user" | "platform" | "team";

// ── 建表 ──
db.exec(`
	CREATE TABLE IF NOT EXISTS favorites (
		asset_id   TEXT NOT NULL,
		owner_type TEXT NOT NULL,              -- 'user' | 'platform'
		owner_id   TEXT NOT NULL DEFAULT '',   -- 平台收藏为空串
		created_at INTEGER NOT NULL,
		PRIMARY KEY (asset_id, owner_type, owner_id)
	);
	CREATE INDEX IF NOT EXISTS idx_fav_owner ON favorites(owner_type, owner_id, created_at);
	CREATE INDEX IF NOT EXISTS idx_fav_asset ON favorites(asset_id);

	CREATE TABLE IF NOT EXISTS quota_grants (
		id         TEXT PRIMARY KEY,
		owner_type TEXT NOT NULL,              -- 'user' | 'team'
		owner_id   TEXT NOT NULL,
		bytes      INTEGER NOT NULL,
		code       TEXT,                       -- 核销的扩容卡号
		granted_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_grant_owner ON quota_grants(owner_type, owner_id, expires_at);
`);

const now = () => Math.floor(Date.now() / 1000);

// ── 收藏 ──

const stmtFavAdd = db.prepare("INSERT OR IGNORE INTO favorites (asset_id, owner_type, owner_id, created_at) VALUES (?, ?, ?, ?)");
const stmtFavDel = db.prepare("DELETE FROM favorites WHERE asset_id = ? AND owner_type = ? AND owner_id = ?");
const stmtFavHas = db.prepare("SELECT 1 AS v FROM favorites WHERE asset_id = ? AND owner_type = ? AND owner_id = ?");
const stmtFavCountForAsset = db.prepare("SELECT COUNT(*) AS n FROM favorites WHERE asset_id = ?");
// ⚠ 这条语句引用的是 **assets 表**（由 store/assets.ts 建），本模块并不 import 它——
// 模块加载期预编译会撞上「表还没建」（谁先被 import 决定成败，生产环境只是碰巧 routes 先加载了 assets）。
// 故延迟到首次使用时才编译：既解开加载顺序耦合，又保留预编译复用。
let _refTouch: ReturnType<typeof db.prepare> | null = null;
const stmtRefTouch = {
	run(...args: (string | number)[]) {
		if (!_refTouch) _refTouch = db.prepare("UPDATE assets SET last_ref_at = ? WHERE id = ? AND purged_at IS NULL");
		return _refTouch.run(...args);
	},
};

export interface FavoriteRow {
	assetId: string;
	createdAt: number;
	type: string;
	contentType: string;
	name?: string;
	url: string;
	sizeBytes: number;
	/** 该资产被平台也收藏了（管理端二次收藏），用户取消也不会掉出永久保留 */
	platformPinned: boolean;
}

/** 某人的收藏列表（JOIN assets 带出展示所需字段；已打墓碑的行也列出——让用户看得见「已失效」） */
export function listFavorites(ownerType: OwnerType, ownerId: string, opts?: { type?: string; limit?: number; offset?: number }): FavoriteRow[] {
	const where: string[] = ["f.owner_type = ?", "f.owner_id = ?"];
	const args: (string | number)[] = [ownerType, ownerId];
	if (opts?.type) {
		where.push("a.type = ?");
		args.push(opts.type);
	}
	const rows = db
		.prepare(
			`SELECT f.asset_id AS asset_id, f.created_at AS created_at, a.type, a.content_type, a.name, a.url,
			        COALESCE(a.size_bytes, 0) AS size_bytes,
			        EXISTS(SELECT 1 FROM favorites p WHERE p.asset_id = f.asset_id AND p.owner_type = 'platform') AS platform_pinned
			 FROM favorites f JOIN assets a ON a.id = f.asset_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
		)
		.all(...args, opts?.limit ?? 500, opts?.offset ?? 0) as Record<string, unknown>[];
	return rows.map((r) => ({
		assetId: String(r.asset_id),
		createdAt: Number(r.created_at),
		type: String(r.type),
		contentType: String(r.content_type),
		name: (r.name as string) ?? undefined,
		url: String(r.url ?? ""),
		sizeBytes: Number(r.size_bytes),
		platformPinned: !!Number(r.platform_pinned),
	}));
}

/** 某人收藏占用的字节数（实时 SUM，不做计数器） */
export function favoriteUsage(ownerType: OwnerType, ownerId: string): { bytes: number; count: number } {
	const r = db
		.prepare(
			`SELECT COUNT(*) AS n, COALESCE(SUM(a.size_bytes), 0) AS b
			 FROM favorites f JOIN assets a ON a.id = f.asset_id
			 WHERE f.owner_type = ? AND f.owner_id = ?`,
		)
		.get(ownerType, ownerId) as { n: number; b: number };
	return { bytes: Number(r.b), count: Number(r.n) };
}

/** 这批资产里哪些已被此人收藏（客户端渲染 ☆ 用，一次查完不逐个问） */
export function favoriteFlags(ownerType: OwnerType, ownerId: string, assetIds: string[]): string[] {
	const ids = [...new Set(assetIds.filter(Boolean))].slice(0, 2000);
	if (!ids.length) return [];
	const ph = ids.map(() => "?").join(",");
	return (
		db
			.prepare(`SELECT asset_id FROM favorites WHERE owner_type = ? AND owner_id = ? AND asset_id IN (${ph})`)
			.all(ownerType, ownerId, ...ids) as { asset_id: string }[]
	).map((r) => r.asset_id);
}

export function isFavorited(assetId: string, ownerType: OwnerType, ownerId: string): boolean {
	return !!stmtFavHas.get(assetId, ownerType, ownerId);
}

/**
 * 加收藏。配额不足时**拒绝并说明差多少**（不静默截断）。
 * 已收藏则幂等返回 ok（不重复计费配额）。
 */
export function addFavorite(
	assetId: string,
	ownerType: OwnerType,
	ownerId: string,
	quota: { limitBytes: number; usedBytes: number },
	assetBytes: number,
): { ok: true } | { ok: false; error: string; needBytes: number } {
	if (isFavorited(assetId, ownerType, ownerId)) return { ok: true };
	// 平台收藏（管理端审核）不占用户配额，也不受限
	if (ownerType !== "platform" && quota.usedBytes + assetBytes > quota.limitBytes) {
		const need = quota.usedBytes + assetBytes - quota.limitBytes;
		return { ok: false, error: "收藏空间已满，请取消部分收藏或使用扩容卡（不影响正常生成与使用）", needBytes: need };
	}
	stmtFavAdd.run(assetId, ownerType, ownerId, now());
	stmtRefTouch.run(now(), assetId); // 收藏即视为一次引用
	return { ok: true };
}

/**
 * 取消收藏。⚠ **绝不立即删对象**——把 last_ref_at 刷成当下，
 * 转入「被引用 +N 天」倒计时（方案 §4.2）。若还有别人（或平台）收藏着，则依然永久保留。
 */
export function removeFavorite(assetId: string, ownerType: OwnerType, ownerId: string): { removed: boolean; stillPinned: boolean } {
	const r = stmtFavDel.run(assetId, ownerType, ownerId);
	stmtRefTouch.run(now(), assetId);
	const left = Number((stmtFavCountForAsset.get(assetId) as { n: number }).n);
	return { removed: Number(r.changes) > 0, stillPinned: left > 0 };
}

/** 删用户时级联清其收藏（调用方：users.deleteUser） */
export function dropOwnerFavorites(ownerType: OwnerType, ownerId: string): number {
	// 先把这些资产的 last_ref_at 刷新，再删收藏——保证它们走倒计时而不是立刻掉进「从未引用」档
	const ids = (db.prepare("SELECT asset_id FROM favorites WHERE owner_type = ? AND owner_id = ?").all(ownerType, ownerId) as { asset_id: string }[]).map((r) => r.asset_id);
	const t = now();
	for (const id of ids) stmtRefTouch.run(t, id);
	const r = db.prepare("DELETE FROM favorites WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId);
	return Number(r.changes);
}

/** 全站收藏概览（管理端「配额」页）：按拥有者聚合，按占用降序 */
export function favoriteOwnersOverview(limit = 100): { ownerType: string; ownerId: string; count: number; bytes: number }[] {
	return (
		db
			.prepare(
				`SELECT f.owner_type, f.owner_id, COUNT(*) AS n, COALESCE(SUM(a.size_bytes),0) AS b
				 FROM favorites f JOIN assets a ON a.id = f.asset_id
				 GROUP BY f.owner_type, f.owner_id ORDER BY b DESC LIMIT ?`,
			)
			.all(limit) as { owner_type: string; owner_id: string; n: number; b: number }[]
	).map((r) => ({ ownerType: r.owner_type, ownerId: r.owner_id, count: Number(r.n), bytes: Number(r.b) }));
}

/** 永久保留的资产 id 集合大小（清理任务用；平台+用户并集） */
export function favoritedAssetCount(): number {
	return Number((db.prepare("SELECT COUNT(DISTINCT asset_id) AS n FROM favorites").get() as { n: number }).n);
}

// ── 配额授予（扩容卡核销后写入）──

export interface QuotaGrant {
	id: string;
	ownerType: OwnerType;
	ownerId: string;
	bytes: number;
	code?: string;
	grantedAt: number;
	expiresAt: number;
}

/**
 * 授予扩容额度。⚠ **多张卡容量叠加、各自独立计时**（方案 §5.4 推荐规则 1）：
 * 买两张 = +400MB，第一张到期后自动回落 +200MB。故每张卡一行，不合并。
 */
export function grantQuota(ownerType: OwnerType, ownerId: string, bytes: number, days: number, code?: string): QuotaGrant {
	const t = now();
	const g: QuotaGrant = { id: genId("qg"), ownerType, ownerId, bytes, code, grantedAt: t, expiresAt: t + days * 86400 };
	db.prepare("INSERT INTO quota_grants (id, owner_type, owner_id, bytes, code, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
		g.id, g.ownerType, g.ownerId, g.bytes, g.code ?? null, g.grantedAt, g.expiresAt,
	);
	return g;
}

/** 当前生效的扩容额度合计（已过期的自动不计——按 expires_at 过滤，不需要清理任务） */
export function grantedBytes(ownerType: OwnerType, ownerId: string): number {
	const r = db
		.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM quota_grants WHERE owner_type = ? AND owner_id = ? AND expires_at > ?")
		.get(ownerType, ownerId, now()) as { b: number };
	return Number(r.b);
}

/** 某人的扩容卡明细（客户端「我的扩容」/管理端配额页） */
export function listGrants(ownerType: OwnerType, ownerId: string, includeExpired = false): QuotaGrant[] {
	const rows = db
		.prepare(
			`SELECT id, owner_type, owner_id, bytes, code, granted_at, expires_at FROM quota_grants
			 WHERE owner_type = ? AND owner_id = ?${includeExpired ? "" : " AND expires_at > " + now()}
			 ORDER BY expires_at DESC`,
		)
		.all(ownerType, ownerId) as Record<string, unknown>[];
	return rows.map((r) => ({
		id: String(r.id),
		ownerType: r.owner_type as OwnerType,
		ownerId: String(r.owner_id),
		bytes: Number(r.bytes),
		code: (r.code as string) ?? undefined,
		grantedAt: Number(r.granted_at),
		expiresAt: Number(r.expires_at),
	}));
}

/** 删用户/解散团队时清其额度 */
export function dropOwnerGrants(ownerType: OwnerType, ownerId: string): number {
	return Number(db.prepare("DELETE FROM quota_grants WHERE owner_type = ? AND owner_id = ?").run(ownerType, ownerId).changes);
}
