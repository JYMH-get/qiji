/**
 * P0-1 台账结构迁移：assets 表加 7 列 + 4 索引 + 存量标 storage='legacy'。
 *
 * 幂等：可重复跑（已存在的列/索引跳过）。**只加列、只加索引，一列都不动、一行都不删**
 *  —— 重建表迁移风险真、收益假（850MB/年 对 SQLite 不是问题），故不做。
 *
 * 与在跑的服务并发安全：ALTER TABLE ADD COLUMN / CREATE INDEX 在 SQLite 是瞬时元数据操作，
 * 服务端的预编译语句都显式列了列名、schema 变更后由 SQLite 自动重新编译，不需要停服。
 * （保险起见仍建议在低峰执行；真出锁冲突有 busy_timeout=30s 兜底。）
 *
 * 用法（容器内 /app/server）：
 *   node scripts/migrate-p0.mjs            # dry-run，只打印计划
 *   node scripts/migrate-p0.mjs --apply    # 真执行
 */
import { parseArgs, openDb, assetColumns, assetIndexes, log, warn, section, dryRunTail, human } from "./_p0lib.mjs";

const { apply } = parseArgs();

// 新增列：全部可空、无默认值 —— ADD COLUMN 不重写表，瞬时完成
const COLUMNS = [
	["storage", "TEXT", "存储档：'legacy'(旧桶/旧前缀) | 'v2'(新布局)。为将来换桶预留，NULL 一律按 legacy 解读"],
	["size_bytes", "INTEGER", "对象字节数（reconcile 回填；配额与容量统计的基础）"],
	["user_id", "TEXT", "产出该资产的用户（按用户配额/清理归属）"],
	["agent_id", "TEXT", "该用户所属渠道商（按商统计容量）"],
	["last_ref_at", "INTEGER", "最后一次被引用上报的时间（epoch 秒）。NULL=从未被引用"],
	["purged_at", "INTEGER", "已清理时间（epoch 秒）。**软删除墓碑，行永不删**——reputAsset 自愈依赖台账行存在"],
	["has_thumb", "INTEGER", "是否已生成缩略图（0/1）"],
];

const INDEXES = [
	["idx_assets_created", "assets(created_at)", "按时间翻页/统计"],
	["idx_assets_user", "assets(user_id, created_at)", "按用户查其素材（配额页/素材库）"],
	["idx_assets_sweep", "assets(purged_at, last_ref_at)", "清理任务扫描"],
	["idx_assets_type", "assets(type, created_at)", "按类型查（素材库分类）"],
];

const db = openDb();

// ── 现状 ──
section("现状");
const cols = assetColumns(db);
const idxs = assetIndexes(db);
const total = db.prepare("SELECT COUNT(*) AS n FROM assets").get().n;
const dbPageInfo = db.prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()").get();
log(`台账行数：${total.toLocaleString()}　库体积：${human(dbPageInfo?.bytes ?? 0)}`);
log(`已有列：${[...cols].join(", ")}`);
log(`已有索引：${[...idxs].filter((n) => !n.startsWith("sqlite_autoindex")).join(", ") || "(无)"}`);

// ── 计划 ──
section("计划");
const addCols = COLUMNS.filter(([name]) => !cols.has(name));
const addIdxs = INDEXES.filter(([name]) => !idxs.has(name));

if (!addCols.length) log("列：全部已存在，跳过");
for (const [name, type, note] of addCols) log(`  + ALTER TABLE assets ADD COLUMN ${name} ${type};   -- ${note}`);

if (!addIdxs.length) log("索引：全部已存在，跳过");
for (const [name, on, note] of addIdxs) log(`  + CREATE INDEX ${name} ON ${on};   -- ${note}`);

// storage 回填：现有全部对象都在旧桶旧前缀 → legacy
let backfill = 0;
if (cols.has("storage")) {
	backfill = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE storage IS NULL").get().n;
} else {
	backfill = total; // 列还不存在 → 加完就是全表
}
if (backfill > 0) log(`  + UPDATE assets SET storage='legacy' WHERE storage IS NULL;   -- ${backfill.toLocaleString()} 行`);
else log("storage 回填：无待处理行");

if (!addCols.length && !addIdxs.length && backfill === 0) {
	log("\n✓ 无事可做，库已是 P0 结构。");
	db.close();
	process.exit(0);
}

if (!apply) {
	dryRunTail("node scripts/migrate-p0.mjs");
	db.close();
	process.exit(0);
}

// ── 执行 ──
section("执行");
db.exec("BEGIN IMMEDIATE");
try {
	for (const [name, type] of addCols) {
		db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${type}`);
		log(`✓ 列 ${name}`);
	}
	for (const [name, on] of INDEXES.filter(([n]) => !idxs.has(n))) {
		db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${on}`);
		log(`✓ 索引 ${name}`);
	}
	const r = db.prepare("UPDATE assets SET storage = 'legacy' WHERE storage IS NULL").run();
	log(`✓ storage='legacy' 回填 ${Number(r.changes).toLocaleString()} 行`);
	db.exec("COMMIT");
} catch (e) {
	try {
		db.exec("ROLLBACK");
	} catch {
		/* 已回滚 */
	}
	console.error("\n✗ 迁移失败，已回滚：", e?.message ?? e);
	db.close();
	process.exit(1);
}

// ── 复核 ──
section("复核");
const cols2 = assetColumns(db);
const idxs2 = assetIndexes(db);
const missCol = COLUMNS.filter(([n]) => !cols2.has(n)).map(([n]) => n);
const missIdx = INDEXES.filter(([n]) => !idxs2.has(n)).map(([n]) => n);
const left = db.prepare("SELECT COUNT(*) AS n FROM assets WHERE storage IS NULL").get().n;
if (missCol.length) warn(`仍缺列：${missCol.join(", ")}`);
if (missIdx.length) warn(`仍缺索引：${missIdx.join(", ")}`);
if (left) warn(`仍有 ${left} 行 storage 为空（迁移期间新写入的属正常，服务端把 NULL 当 legacy）`);
if (!missCol.length && !missIdx.length) log("✓ 结构齐全");

db.close();
console.log("\n下一步：node scripts/reconcile.mjs   （先 dry-run 看对账结果）\n");
