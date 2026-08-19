/**
 * P0-2 台账 ↔ 对象存储 实时对账。
 *
 * ⚠ **必须在服务器上、对实时台账跑**。对下载下来的静态 qiji.db 快照跑会把
 *   「快照之后新产生的正常对象」全部误判成孤儿（本项目已踩过一次）。
 *
 * 做三件事（每件都可单独关）：
 *   ① 回填 size_bytes —— 桶里对象的真实字节数（配额/容量统计的基础）
 *   ② 标记死记录     —— 台账有行、桶里没对象 → purged_at 打墓碑（**行永不删**：
 *                        store/assets.ts reputAsset 第一行 `if (!rec) return undefined`，
 *                        删了行客户端的死链自愈就永远修不回来）
 *   ③ 补登孤儿对象   —— 桶里有对象、台账没行 → 按对象键反解 id 补台账，
 *                        并同步抬高 asset_seqs 防止 id 被复用
 *
 * 用法（容器内 /app/server）：
 *   node scripts/reconcile.mjs                      # dry-run 全量对账，只出报告
 *   node scripts/reconcile.mjs --report=/tmp/r.json # dry-run + 落一份 JSON 明细
 *   node scripts/reconcile.mjs --apply              # 真执行
 *   可选：--prefix=assets/   只对账该前缀（其余对象与台账行一律"不判断"）
 *         --no-size / --no-mark-dead / --no-adopt   关掉某一件事
 *         --force                                   死记录占比超 20% 时仍继续
 */
import { parseArgs, openDb, assetColumns, ossConfig, s3Client, listAllObjects, idFromKey, metaFromExt, log, warn, die, section, human, writeReport, dryRunTail, mask } from "./_p0lib.mjs";

const { apply, flags, opts } = parseArgs();
const PREFIX = opts.prefix ?? "";
const DO_SIZE = !flags.has("--no-size");
const DO_DEAD = !flags.has("--no-mark-dead");
const DO_ADOPT = !flags.has("--no-adopt");
const FORCE = flags.has("--force");
const NOW = Math.floor(Date.now() / 1000);

const db = openDb();
const cols = assetColumns(db);
for (const need of ["storage", "size_bytes", "purged_at"]) {
	if (!cols.has(need)) die(`assets 表缺列 ${need} —— 先跑 node scripts/migrate-p0.mjs --apply`);
}

// ── 1. 读台账 ──
section("读取台账");
const rows = db.prepare("SELECT id, type, url, oss_key, created_at, size_bytes, purged_at FROM assets").all();
log(`台账 ${rows.length.toLocaleString()} 行`);

const byKey = new Map(); // ossKey → row
let noKey = 0; // 无对象键（未配 OSS 时期的内存态记录）
let alreadyPurged = 0;
for (const r of rows) {
	if (r.purged_at != null) alreadyPurged += 1;
	if (!r.oss_key) {
		noKey += 1;
		continue;
	}
	byKey.set(r.oss_key, r);
}
const idSet = new Set(rows.map((r) => r.id));
log(`  有对象键 ${byKey.size.toLocaleString()}　无对象键 ${noKey.toLocaleString()}（未配 OSS 时期的记录，不参与对账）　已打墓碑 ${alreadyPurged.toLocaleString()}`);

// ── 2. 列桶 ──
section("列举对象存储");
const o = ossConfig();
log(`endpoint=${o.endpoint}　bucket=${o.bucket}　region=${o.region}　key=${mask(o.accessKeyId)}`);
log(`前缀过滤：${PREFIX ? `"${PREFIX}"` : "(全桶)"}`);
const client = await s3Client();
const objects = await listAllObjects(client, o.bucket, PREFIX);
let bucketBytes = 0;
for (const v of objects.values()) bucketBytes += v.size;
log(`桶内 ${objects.size.toLocaleString()} 个对象，合计 ${human(bucketBytes)}`);

if (objects.size === 0) die("桶里一个对象都没列到 —— 极可能是配置/权限问题。已中止，绝不在这种状态下标死记录。");

// ── 3. 比对 ──
section("比对");
const inPrefix = (key) => !PREFIX || key.startsWith(PREFIX);

/** ① size 回填 */
const sizeFix = [];
/** ② 死记录（台账有、桶没有） */
const dead = [];
/** ③ 孤儿（桶有、台账没有），可补登 */
const adopt = [];
/** 孤儿但 id 已被台账占用（同 id 不同扩展名）——不动，只报告 */
const idConflict = [];
/** 对象键不符合 `<前缀><8位>.<ext>` 命名——不动，只报告 */
const unknownKeys = [];
/** 台账行的键落在过滤前缀之外——本轮不判断 */
let outOfScope = 0;
/** 打过墓碑但对象又出现在桶里（客户端死链自愈重传过）——只报告不自动复活 */
const revived = [];

for (const [key, row] of byKey) {
	if (!inPrefix(key)) {
		outOfScope += 1;
		continue;
	}
	const obj = objects.get(key);
	if (obj) {
		if (row.size_bytes == null || Number(row.size_bytes) !== obj.size) sizeFix.push({ id: row.id, key, size: obj.size, was: row.size_bytes });
		// 打过墓碑但对象又回来了（客户端本地副本自愈重传）：只报告，不自动复活
		// —— 复活语义归 P1 的引用上报接管，这里自作主张会和清理任务打架
		if (row.purged_at != null) revived.push({ id: row.id, key, purgedAt: row.purged_at });
	} else if (row.purged_at == null) {
		dead.push({ id: row.id, key, createdAt: row.created_at });
	}
}

let orphanBytes = 0;
for (const [key, obj] of objects) {
	if (byKey.has(key)) continue;
	const parsed = idFromKey(key);
	if (!parsed) {
		unknownKeys.push({ key, size: obj.size });
		continue;
	}
	if (idSet.has(parsed.id)) {
		idConflict.push({ id: parsed.id, key, size: obj.size });
		continue;
	}
	orphanBytes += obj.size;
	adopt.push({ ...parsed, key, size: obj.size, lastModified: obj.lastModified });
}

const deadPct = rows.length ? (dead.length / rows.length) * 100 : 0;
log(`① size 待回填　　 ${sizeFix.length.toLocaleString()} 行`);
log(`② 死记录（待打墓碑）${dead.length.toLocaleString()} 行（占台账 ${deadPct.toFixed(1)}%）`);
log(`③ 孤儿对象（待补登）${adopt.length.toLocaleString()} 个，${human(orphanBytes)}`);
if (revived.length) warn(`墓碑行的对象又出现在桶里 ${revived.length} 个（自愈重传）—— 不自动复活，见报告`);
if (idConflict.length) warn(`id 已被占用的孤儿 ${idConflict.length} 个（同 id 不同扩展名）—— 不自动处理，见报告`);
if (unknownKeys.length) warn(`命名不符的对象 ${unknownKeys.length} 个 —— 不自动处理，见报告`);
if (outOfScope) log(`前缀之外的台账行 ${outOfScope.toLocaleString()} 行 —— 本轮不判断`);

// 报告
writeReport(opts.report, {
	at: new Date().toISOString(),
	bucket: o.bucket,
	prefix: PREFIX,
	ledgerRows: rows.length,
	bucketObjects: objects.size,
	bucketBytes,
	sizeFix: sizeFix.length,
	dead: dead.slice(0, 5000),
	deadTotal: dead.length,
	adopt: adopt.slice(0, 5000).map((a) => ({ id: a.id, key: a.key, size: a.size })),
	adoptTotal: adopt.length,
	revived,
	idConflict,
	unknownKeys: unknownKeys.slice(0, 2000),
});

// 安全闸：死记录占比异常高 → 多半是前缀/桶配错，或对着旧快照跑
if (DO_DEAD && dead.length && deadPct > 20 && !FORCE) {
	die(
		`死记录占台账 ${deadPct.toFixed(1)}%（>20%）—— 这通常意味着桶/前缀配错，或在对静态快照对账。\n` +
			`  已中止。确认无误后加 --force 继续，或先用 --no-mark-dead 只做 size 回填与孤儿补登。`,
	);
}

if (!sizeFix.length && !dead.length && !adopt.length) {
	log("\n✓ 台账与桶完全一致，无事可做。");
	db.close();
	process.exit(0);
}

if (!apply) {
	// dry-run 抽样，便于人工核对
	section("抽样（各前 5 条）");
	for (const s of sizeFix.slice(0, 5)) log(`  size  ${s.id}  ${s.was ?? "NULL"} → ${s.size}`);
	for (const d of dead.slice(0, 5)) log(`  dead  ${d.id}  ${d.key}  (建于 ${d.createdAt})`);
	for (const a of adopt.slice(0, 5)) log(`  adopt ${a.id}  ${a.key}  ${human(a.size)}`);
	dryRunTail("node scripts/reconcile.mjs");
	db.close();
	process.exit(0);
}

// ── 4. 执行 ──
section("执行");
const stmtSize = db.prepare("UPDATE assets SET size_bytes = ? WHERE id = ?");
const stmtDead = db.prepare("UPDATE assets SET purged_at = ? WHERE id = ? AND purged_at IS NULL");
const stmtAdopt = db.prepare(
	"INSERT OR IGNORE INTO assets (id, type, content_type, name, url, oss_key, duration_ms, created_at, storage, size_bytes) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'legacy', ?)",
);
const stmtSeqGet = db.prepare("SELECT seq FROM asset_seqs WHERE prefix = ?");
const stmtSeqSet = db.prepare("INSERT INTO asset_seqs (prefix, seq) VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET seq = excluded.seq");

let nSize = 0;
let nDead = 0;
let nAdopt = 0;
const seqBump = new Map(); // prefix → 需要抬到的最大 seq

db.exec("BEGIN IMMEDIATE");
try {
	if (DO_SIZE) {
		for (const s of sizeFix) nSize += Number(stmtSize.run(s.size, s.id).changes);
		log(`✓ size 回填 ${nSize.toLocaleString()} 行`);
	} else log("－ 跳过 size 回填（--no-size）");

	if (DO_DEAD) {
		for (const d of dead) nDead += Number(stmtDead.run(NOW, d.id).changes);
		log(`✓ 死记录打墓碑 ${nDead.toLocaleString()} 行（purged_at=${NOW}，行保留）`);
	} else log("－ 跳过死记录标记（--no-mark-dead）");

	if (DO_ADOPT) {
		for (const a of adopt) {
			const { contentType, type } = metaFromExt(a.ext);
			const createdAt = (a.lastModified ?? new Date()).toISOString();
			const url = `${o.publicBase}/${a.key}`;
			nAdopt += Number(stmtAdopt.run(a.id, type, contentType, null, url, a.key, createdAt, a.size).changes);
			const cur = seqBump.get(a.prefix) ?? 0;
			if (a.seq > cur) seqBump.set(a.prefix, a.seq);
		}
		log(`✓ 孤儿补登 ${nAdopt.toLocaleString()} 行`);
		// ⚠ 关键：补登的 id 可能比当前 seq 大（服务端重启丢过 pending 等），不抬 seq 会导致 id 复用
		for (const [prefix, maxSeq] of seqBump) {
			const cur = Number(stmtSeqGet.get(prefix)?.seq ?? 0);
			if (maxSeq > cur) {
				stmtSeqSet.run(prefix, maxSeq);
				log(`  ↑ asset_seqs['${prefix}'] ${cur} → ${maxSeq}（防 id 复用）`);
			}
		}
	} else log("－ 跳过孤儿补登（--no-adopt）");

	db.exec("COMMIT");
} catch (e) {
	try {
		db.exec("ROLLBACK");
	} catch {
		/* 已回滚 */
	}
	console.error("\n✗ 对账写入失败，已回滚：", e?.message ?? e);
	db.close();
	process.exit(1);
}

db.close();
console.log("\n下一步：node scripts/verify.mjs   （校验台账 ↔ 桶是否已一致）\n");
