#!/usr/bin/env node
/**
 * 收藏 + 共享素材库素材 → 新 OSS 服务端迁移（第225轮，旧桶数据舍弃前的抢救性搬运）。
 *
 * 背景：整体换新对象存储（第224轮桥接），普通素材靠用户本地副本恢复；但**收藏**（=永久保留承诺）
 * 与**共享素材库**（多人共用、来源用户未必在线）不能指望用户恢复——台账有完整记录、旧桶尚可访问，
 * 由服务端直接搬：下载旧直链 → 按桥接键（<归属账号>/<旧路径>）上传新桶 → 更新台账。
 *
 * 用法（在服务器 server/ 目录下）：
 *   node scripts/migrate-fav-shared.mjs            # dry-run：只统计与列样本，零网络零写入
 *   node scripts/migrate-fav-shared.mjs --apply    # 真迁移
 *   node scripts/migrate-fav-shared.mjs --apply --limit=100   # 限量试跑
 *
 * 语义与服务端 reputAsset 桥接分支完全一致（键格式/台账字段/去重）；
 * 服务器无需停服（assets 表非常驻内存，WAL 并发写安全）。失败项如实列出（旧对象已 404 的
 * 只能等用户本地恢复）。幂等：已迁移的行 url 不再是旧基址，重跑自动跳过。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "..", "data");
const APPLY = process.argv.includes("--apply");
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) ?? "").split("=")[1]) || Infinity;

const readJson = (name, fb) => {
	const p = join(DATA, name);
	if (!existsSync(p)) return fb;
	try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; }
};

// ── 配置解析（与 src/store/storage.ts 同规则的最小镜像）──
const settings = readJson("settings.json", {});
const ossBase = settings.oss ?? {};
const strip = (u) => String(u || "").replace(/\/+$/, "");
function buildProfile(id, c) {
	const endpoint = strip(c.endpoint ?? ossBase.endpoint);
	const bucket = c.bucket ?? ossBase.bucket;
	const host = endpoint.replace(/^https?:\/\//, "");
	return {
		id, endpoint, bucket,
		publicBase: strip(c.publicBase || (endpoint && bucket ? `https://${bucket}.${host}` : ossBase.publicBase)),
		region: c.region ?? ossBase.region ?? "auto",
		accessKeyId: c.accessKeyId ?? ossBase.accessKeyId,
		secretAccessKey: c.secretAccessKey ?? ossBase.secretAccessKey,
		writable: c.writable !== false,
		active: c.active === true,
	};
}
const profCfg = settings.storageProfiles ?? {};
const profiles = Object.fromEntries(Object.entries(profCfg).map(([id, c]) => [id, buildProfile(id, c ?? {})]));
if (!profiles.legacy) profiles.legacy = buildProfile("legacy", { active: !Object.values(profiles).some((p) => p.active) });
const active = Object.values(profiles).find((p) => p.active && p.writable) ?? profiles.legacy;
if (!active.endpoint || !active.bucket || !active.accessKeyId || !active.secretAccessKey) {
	console.error("✗ OSS 未配置完整（settings.json oss 段），中止"); process.exit(2);
}
const OLD_BASES = Array.isArray(settings.ossBridgeOldBases) && settings.ossBridgeOldBases.length
	? settings.ossBridgeOldBases
	: ["https://jianqiji-qiji.cn-nb1.rains3.com"];
const isOld = (u) => !!u && OLD_BASES.some((b) => String(u).startsWith(b));

const s3 = new S3Client({
	region: active.region || "auto",
	endpoint: active.endpoint,
	credentials: { accessKeyId: active.accessKeyId, secretAccessKey: active.secretAccessKey },
	forcePathStyle: false,
	requestChecksumCalculation: "WHEN_REQUIRED",
});

// ── 数据源 ──
const db = new DatabaseSync(join(DATA, "qiji.db"));
db.exec("PRAGMA busy_timeout = 5000");
const users = readJson("users.json", []);
const acctOf = new Map(users.map((u) => [u.id, u.account || ""]));
const sanitize = (s) => String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
const acctSeg = (userId) => sanitize(acctOf.get(userId)) || sanitize(userId) || "anon";

const favIds = db.prepare("SELECT DISTINCT asset_id FROM favorites").all().map((r) => r.asset_id);
const shared = readJson("shared-libs.json", {});
const sharedRecs = Array.isArray(shared.assets) ? shared.assets : [];
const sharedIds = [...new Set(sharedRecs.map((a) => a.assetId).filter(Boolean))];
const sharedNoId = sharedRecs.filter((a) => !a.assetId).length;
const targets = [...new Set([...favIds, ...sharedIds])];

const stmtRow = db.prepare("SELECT id, type, content_type, url, oss_key, storage, size_bytes, user_id, purged_at FROM assets WHERE id = ?");
const stmtBySha = db.prepare("SELECT id, url, oss_key, storage FROM assets WHERE sha256 = ? AND purged_at IS NULL AND oss_key IS NOT NULL AND url <> '' LIMIT 1");
const stmtUpd = db.prepare("UPDATE assets SET url = ?, oss_key = ?, storage = ?, sha256 = ?, has_thumb = 0, purged_at = NULL, last_ref_at = ? WHERE id = ?");

// ── 分类 ──
const cand = [];
let okNew = 0, missing = 0, purged = 0, noUrl = 0;
for (const id of targets) {
	const r = stmtRow.get(id);
	if (!r) { missing += 1; continue; }
	if (r.purged_at != null) { purged += 1; continue; }
	if (!r.url) { noUrl += 1; continue; }
	if (!isOld(r.url)) { okNew += 1; continue; } // 已在新桶/自定义域=无需迁移（重跑幂等靠这里）
	cand.push(r);
}

console.log(`目标：收藏 ${favIds.length} + 共享库 ${sharedIds.length}（去重后 ${targets.length}）`);
console.log(`  待迁移（旧桶链接）: ${cand.length}`);
console.log(`  已在新桶/无需迁移: ${okNew} ｜ 台账缺失: ${missing} ｜ 已清理墓碑: ${purged} ｜ 无直链(降级行): ${noUrl}`);
if (sharedNoId) console.log(`  ⚠ 共享库另有 ${sharedNoId} 条无 assetId 的记录（只存 url 缓存，无台账行可迁——如仍需要请人工处理）`);
if (!APPLY) {
	console.log("\n样本（前 10 条待迁移）：");
	for (const r of cand.slice(0, 10)) console.log(`  ${r.id}  ${(Number(r.size_bytes) / 1024).toFixed(0)}KB  → ${acctSeg(r.user_id)}/${r.oss_key || "(由 url 推导)"}`);
	console.log("\ndry-run 结束（未发起任何网络请求/写入）。确认无误后加 --apply 执行。");
	process.exit(0);
}

// ── 真迁移 ──
const work = cand.slice(0, LIMIT);
let done = 0, migrated = 0, deduped = 0, failed = 0, bytesMoved = 0;
const failures = [];
const timeoutFor = (bytes) => 60_000 + Math.ceil((Number(bytes) || 0) / 102_400) * 1000; // 60s + 1s/100KB
// 同哈希在飞锁：并发下两条同内容行会在对方落库前都查不到去重命中 → 双双上传。
// 第一个到的登记 Promise，后到的等它落库后直接共享；首传失败则 resolve(null)，等待方转为自己上传。
const shaInFlight = new Map();

async function migrateOne(r) {
	const oldPath = (r.oss_key || new URL(r.url).pathname).replace(/^\/+/, "");
	try {
		const resp = await fetch(r.url, { signal: AbortSignal.timeout(timeoutFor(r.size_bytes)) });
		if (!resp.ok) throw new Error(`旧对象下载失败 HTTP ${resp.status}`);
		const bytes = Buffer.from(await resp.arrayBuffer());
		const sha = createHash("sha256").update(bytes).digest("hex");
		const nowSec = Math.floor(Date.now() / 1000);
		for (;;) {
			const dup = stmtBySha.get(sha);
			if (dup && !isOld(dup.url)) {
				// 整桶已有同内容对象（别的行已迁/已恢复）→ 共享，不重复上传
				stmtUpd.run(dup.url, dup.oss_key, dup.storage, sha, nowSec, r.id);
				deduped += 1;
				return;
			}
			const inflight = shaInFlight.get(sha);
			if (!inflight) break;
			const d = await inflight;
			if (d) {
				stmtUpd.run(d.url, d.ossKey, d.storage, sha, nowSec, r.id);
				deduped += 1;
				return;
			}
			// 首传方失败：重查一轮后自己上
		}
		let release;
		shaInFlight.set(sha, new Promise((res) => { release = res; }));
		try {
			const newKey = `${acctSeg(r.user_id)}/${oldPath}`;
			await s3.send(new PutObjectCommand({
				Bucket: active.bucket, Key: newKey, Body: bytes, ContentType: r.content_type || "application/octet-stream",
			}));
			const url = `${active.publicBase}/${newKey}`;
			stmtUpd.run(url, newKey, active.id, sha, nowSec, r.id);
			migrated += 1;
			bytesMoved += bytes.length;
			release({ url, ossKey: newKey, storage: active.id });
		} catch (e) {
			shaInFlight.delete(sha);
			release(null);
			throw e;
		}
	} catch (e) {
		failed += 1;
		failures.push({ id: r.id, error: e.message });
	} finally {
		done += 1;
		if (done % 20 === 0 || done === work.length) {
			console.log(`  进度 ${done}/${work.length}（迁移 ${migrated} / 去重 ${deduped} / 失败 ${failed} / ${(bytesMoved / 1048576).toFixed(1)}MB）`);
		}
	}
}

console.log(`\n开始迁移 ${work.length} 个（并发 4）→ ${active.publicBase}/<账号>/<旧路径>`);
let i = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
	while (i < work.length) await migrateOne(work[i++]);
}));

console.log(`\n完成：迁移 ${migrated} 个（${(bytesMoved / 1048576).toFixed(1)}MB）、内容去重复用 ${deduped} 个、失败 ${failed} 个`);
if (failures.length) {
	console.log("失败清单（旧对象已丢的只能等用户本地副本恢复；网络类错误重跑本脚本即可——幂等）：");
	for (const f of failures.slice(0, 50)) console.log(`  ${f.id}: ${f.error}`);
	if (failures.length > 50) console.log(`  …另 ${failures.length - 50} 条`);
}
db.close();
process.exitCode = failed ? 1 : 0; // 勿用 process.exit()：Windows 上带未决句柄硬退会偶发 0xC0000409 崩码

