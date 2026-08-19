/**
 * P0-3 校验：台账 ↔ 对象存储 是否一致 + P0 结构是否齐全 + 容量分布。
 *
 * **纯只读**，没有 --apply，任何情况下都不写库不写桶。
 * 退出码：0=全绿　1=有不一致（细节见输出）　2=环境/配置问题。
 *
 * 用法（容器内 /app/server）：
 *   node scripts/verify.mjs
 *   node scripts/verify.mjs --prefix=assets/ --report=/tmp/verify.json
 *   node scripts/verify.mjs --no-bucket        # 只查库结构与台账自洽，不列桶（快）
 */
import { parseArgs, openDb, assetColumns, assetIndexes, ossConfig, s3Client, listAllObjects, idFromKey, log, warn, section, human, writeReport } from "./_p0lib.mjs";

const { flags, opts } = parseArgs();
const PREFIX = opts.prefix ?? "";
const CHECK_BUCKET = !flags.has("--no-bucket");

const NEED_COLS = ["storage", "size_bytes", "user_id", "agent_id", "last_ref_at", "purged_at", "has_thumb"];
const NEED_IDXS = ["idx_assets_created", "idx_assets_user", "idx_assets_sweep", "idx_assets_type"];

const db = openDb();
let bad = 0;
const fail = (msg) => {
	bad += 1;
	console.log(`  ✗ ${msg}`);
};
const pass = (msg) => console.log(`  ✓ ${msg}`);

// ── A. 结构 ──
section("A. 表结构");
const cols = assetColumns(db);
const idxs = assetIndexes(db);
const missCol = NEED_COLS.filter((c) => !cols.has(c));
const missIdx = NEED_IDXS.filter((i) => !idxs.has(i));
missCol.length ? fail(`缺列：${missCol.join(", ")}（跑 migrate-p0.mjs --apply）`) : pass(`7 个新列齐全`);
missIdx.length ? fail(`缺索引：${missIdx.join(", ")}`) : pass(`4 个索引齐全`);

if (missCol.length) {
	console.log("\n结构未就绪，后续检查跳过。\n");
	db.close();
	process.exit(1);
}

// ── B. 台账自洽 ──
section("B. 台账自洽");
const q = (sql) => db.prepare(sql).get();
const total = q("SELECT COUNT(*) AS n FROM assets").n;
const purged = q("SELECT COUNT(*) AS n FROM assets WHERE purged_at IS NOT NULL").n;
const live = total - purged;
const noStorage = q("SELECT COUNT(*) AS n FROM assets WHERE storage IS NULL").n;
const noSize = q("SELECT COUNT(*) AS n FROM assets WHERE purged_at IS NULL AND size_bytes IS NULL AND oss_key IS NOT NULL AND oss_key <> ''").n;
const noKey = q("SELECT COUNT(*) AS n FROM assets WHERE oss_key IS NULL OR oss_key = ''").n;
const dupKey = q("SELECT COUNT(*) AS n FROM (SELECT oss_key FROM assets WHERE oss_key IS NOT NULL AND oss_key <> '' GROUP BY oss_key HAVING COUNT(*) > 1)").n;
const bytes = q("SELECT COALESCE(SUM(size_bytes),0) AS b FROM assets WHERE purged_at IS NULL").b;

log(`台账 ${total.toLocaleString()} 行　存活 ${live.toLocaleString()}　墓碑 ${purged.toLocaleString()}`);
log(`存活合计 ${human(bytes)}（按 size_bytes）`);
noStorage ? warn(`${noStorage.toLocaleString()} 行 storage 为空（服务端把 NULL 当 legacy，不算错；迁移后新写入的属正常）`) : pass("storage 全部已标");
noSize ? fail(`${noSize.toLocaleString()} 行存活记录缺 size_bytes（跑 reconcile.mjs --apply 回填）`) : pass("存活记录 size_bytes 齐全");
dupKey ? fail(`${dupKey} 个对象键被多行台账引用（异常，需人工查）`) : pass("对象键无重复引用");
if (noKey) log(`  · ${noKey.toLocaleString()} 行无对象键（未配 OSS 时期的内存态记录，不参与对账）`);

// seq 是否落后于已存在的最大 id（落后 = 会分配出重复 id）
section("C. id 序列（防复用）");
const seqs = db.prepare("SELECT prefix, seq FROM asset_seqs").all();
const maxByPrefix = new Map();
for (const r of db.prepare("SELECT id FROM assets").all()) {
	const m = /^([A-Za-z]{1,12})(\d{8})$/.exec(r.id);
	if (!m) continue;
	const n = Number(m[2]);
	if (n > (maxByPrefix.get(m[1]) ?? 0)) maxByPrefix.set(m[1], n);
}
let seqBad = 0;
for (const [prefix, maxId] of maxByPrefix) {
	const cur = Number(seqs.find((s) => s.prefix === prefix)?.seq ?? 0);
	if (cur < maxId) {
		fail(`asset_seqs['${prefix}']=${cur} < 台账最大 id ${maxId} —— 下次分配会撞已用 id`);
		seqBad += 1;
	}
}
if (!seqBad) pass(`${maxByPrefix.size} 个前缀的序列都不低于台账最大 id`);

// ── D. 对桶 ──
let bucketStat = null;
if (CHECK_BUCKET) {
	section("D. 台账 ↔ 对象存储");
	const o = ossConfig();
	log(`bucket=${o.bucket}　前缀=${PREFIX || "(全桶)"}`);
	const client = await s3Client();
	const objects = await listAllObjects(client, o.bucket, PREFIX);
	let bucketBytes = 0;
	for (const v of objects.values()) bucketBytes += v.size;
	log(`桶内 ${objects.size.toLocaleString()} 个对象，${human(bucketBytes)}`);

	const rows = db.prepare("SELECT id, oss_key, size_bytes, purged_at FROM assets WHERE oss_key IS NOT NULL AND oss_key <> ''").all();
	const byKey = new Map(rows.map((r) => [r.oss_key, r]));
	const inPrefix = (k) => !PREFIX || k.startsWith(PREFIX);

	let liveMissing = 0; // 存活台账，桶里没有 → 该标墓碑
	let sizeMismatch = 0; // size 与桶实际不符
	let tombstoneAlive = 0; // 墓碑行对象却还在（自愈重传/未真删）
	for (const [key, r] of byKey) {
		if (!inPrefix(key)) continue;
		const obj = objects.get(key);
		if (!obj) {
			if (r.purged_at == null) liveMissing += 1;
		} else {
			if (r.purged_at != null) tombstoneAlive += 1;
			else if (r.size_bytes != null && Number(r.size_bytes) !== obj.size) sizeMismatch += 1;
		}
	}

	let orphan = 0;
	let orphanBytes = 0;
	let unnamed = 0;
	for (const [key, obj] of objects) {
		if (byKey.has(key)) continue;
		if (!idFromKey(key)) unnamed += 1;
		orphan += 1;
		orphanBytes += obj.size;
	}

	liveMissing ? fail(`${liveMissing.toLocaleString()} 行存活台账在桶里找不到对象（跑 reconcile.mjs --apply 打墓碑）`) : pass("存活台账全部有对象");
	orphan ? fail(`${orphan.toLocaleString()} 个孤儿对象无台账引用，${human(orphanBytes)}（其中 ${unnamed} 个命名不符）`) : pass("桶内无孤儿对象");
	sizeMismatch ? fail(`${sizeMismatch.toLocaleString()} 行 size_bytes 与桶实际不符`) : pass("size_bytes 与桶一致");
	if (tombstoneAlive) warn(`${tombstoneAlive.toLocaleString()} 个墓碑行的对象仍在桶里（客户端自愈重传过，或清理尚未执行）`);

	bucketStat = { objects: objects.size, bucketBytes, liveMissing, orphan, orphanBytes, unnamed, sizeMismatch, tombstoneAlive };
}

// ── E. 容量分布（运营参考）──
section("E. 容量分布（存活记录）");
const byType = db
	.prepare("SELECT type, COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b FROM assets WHERE purged_at IS NULL GROUP BY type ORDER BY b DESC")
	.all();
for (const r of byType) log(`  ${String(r.type).padEnd(8)} ${String(r.n.toLocaleString()).padStart(10)} 个　${human(r.b).padStart(10)}`);
const byAge = db
	.prepare(
		`SELECT CASE
			WHEN created_at >= datetime('now','-7 days')  THEN '  ≤7 天'
			WHEN created_at >= datetime('now','-14 days') THEN ' 7-14 天'
			WHEN created_at >= datetime('now','-30 days') THEN '14-30 天'
			WHEN created_at >= datetime('now','-90 days') THEN '30-90 天'
			ELSE '  >90 天' END AS band,
			COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS b
		 FROM assets WHERE purged_at IS NULL GROUP BY band ORDER BY MIN(created_at) DESC`,
	)
	.all();
log("  ── 按年龄 ──");
for (const r of byAge) log(`  ${r.band} ${String(r.n.toLocaleString()).padStart(10)} 个　${human(r.b).padStart(10)}`);

writeReport(opts.report, { at: new Date().toISOString(), total, live, purged, noSize, noStorage, noKey, dupKey, bytes, seqBad, bucket: bucketStat, byType, byAge });

// ── 结论 ──
console.log(`\n${"═".repeat(64)}`);
if (bad === 0) console.log("✓ 全部检查通过：台账与对象存储一致，P0 结构就绪。");
else console.log(`✗ ${bad} 项不一致 —— 见上方 ✗ 行。`);
console.log(`${"═".repeat(64)}\n`);

db.close();
process.exit(bad === 0 ? 0 : 1);
