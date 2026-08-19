/**
 * P0 存储改造脚本公共库（零 server 源码依赖，纯 node:sqlite + @aws-sdk/client-s3）。
 *
 * 设计原则：
 *  - **不 import server/src 任何模块**——避免触发 assets.ts 首启迁移、settings 落盘等副作用，
 *    也避免脚本在生产上跑时和在跑的服务抢同一份内存状态。
 *  - 只读 data/settings.json + 环境变量拿 OSS 配置（与 store/settings.ts getOssConfig 同一优先级）。
 *  - 默认 dry-run：不带 --apply 一律只打印计划、绝不写库/写桶。
 *
 * 运行环境：容器内 /app/server（docker compose exec qiji-server node scripts/xxx.mjs）。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(here, "..", "data");
export const DB_PATH = join(DATA_DIR, "qiji.db");

// ── 命令行 ──

/** 解析 argv：--apply 才真执行（缺省 dry-run）；--k=v 进 opts */
export function parseArgs(argv = process.argv.slice(2)) {
	const flags = new Set(argv.filter((a) => a.startsWith("--") && !a.includes("=")));
	const opts = {};
	for (const a of argv) {
		const m = /^--([^=]+)=(.*)$/.exec(a);
		if (m) opts[m[1]] = m[2];
	}
	return { apply: flags.has("--apply"), dryRun: !flags.has("--apply"), flags, opts };
}

const t0 = Date.now();
const stamp = () => `${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(6)}s`;
export const log = (...a) => console.log(`[${stamp()}]`, ...a);
export const warn = (...a) => console.warn(`[${stamp()}] ⚠`, ...a);
export const die = (msg) => {
	console.error(`\n✗ ${msg}\n`);
	process.exit(2);
};

/** 打印一行标题分隔 */
export function section(title) {
	console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

/** 掩码密钥：只留首 4 末 2 */
export const mask = (s) => (!s ? "(空)" : s.length <= 8 ? "****" : `${s.slice(0, 4)}****${s.slice(-2)}`);

/** 人类可读字节 */
export function human(n) {
	const u = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = Number(n) || 0;
	while (v >= 1024 && i < u.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

// ── SQLite ──

/** 打开台账库（WAL + busy_timeout：与在跑的服务并发安全） */
export function openDb() {
	if (!existsSync(DB_PATH)) die(`找不到台账库：${DB_PATH}\n（脚本须在 server 目录下运行，容器内为 /app/server）`);
	const db = new DatabaseSync(DB_PATH);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 30000"); // 服务在写时最多等 30s，不硬失败
	return db;
}

/** assets 表现有列名集合 */
export function assetColumns(db) {
	return new Set(db.prepare("PRAGMA table_info(assets)").all().map((c) => c.name));
}

/** assets 表现有索引名集合（不含自动索引） */
export function assetIndexes(db) {
	return new Set(db.prepare("PRAGMA index_list(assets)").all().map((i) => i.name));
}

// ── OSS 配置（与 store/settings.ts getOssConfig 同优先级：管理端 settings.json ?? .env）──

const strip = (u) => (u || "").replace(/\/+$/, "");

export function ossConfig() {
	let s = {};
	try {
		s = JSON.parse(readFileSync(join(DATA_DIR, "settings.json"), "utf8")).oss ?? {};
	} catch {
		/* 没有 settings.json 就全走环境变量 */
	}
	const endpoint = strip(s.endpoint ?? process.env.OSS_ENDPOINT ?? "");
	const bucket = s.bucket ?? process.env.OSS_BUCKET ?? "";
	const host = endpoint.replace(/^https?:\/\//, "");
	const publicBase = strip(s.publicBase || process.env.OSS_PUBLIC_BASE || (endpoint && bucket ? `https://${bucket}.${host}` : ""));
	return {
		endpoint,
		bucket,
		accessKeyId: s.accessKeyId ?? process.env.OSS_ACCESS_KEY_ID ?? "",
		secretAccessKey: s.secretAccessKey ?? process.env.OSS_SECRET_ACCESS_KEY ?? "",
		region: s.region ?? process.env.OSS_REGION ?? "auto",
		publicBase,
	};
}

export async function s3Client() {
	const o = ossConfig();
	if (!o.endpoint || !o.bucket || !o.accessKeyId || !o.secretAccessKey) die("OSS 未配置（endpoint/bucket/key 缺失）——检查 data/settings.json 或 .env");
	const { S3Client } = await import("@aws-sdk/client-s3");
	return new S3Client({
		region: o.region || "auto",
		endpoint: o.endpoint,
		credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
		forcePathStyle: false,
		requestChecksumCalculation: "WHEN_REQUIRED", // 与 store/oss.ts 一致，rains3 老式校验语义
	});
}

/**
 * 全量列桶（分页到底）。返回 Map<key, {size, lastModified}>。
 * 50 万对象量级约 500 次请求，几十秒；每页回调用于打进度。
 */
export async function listAllObjects(client, bucket, prefix = "") {
	const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
	const map = new Map();
	let token;
	let pages = 0;
	do {
		const r = await client.send(
			new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix || undefined, ContinuationToken: token, MaxKeys: 1000 }),
		);
		for (const c of r.Contents ?? []) map.set(c.Key, { size: Number(c.Size) || 0, lastModified: c.LastModified ? new Date(c.LastModified) : null });
		pages += 1;
		token = r.IsTruncated ? r.NextContinuationToken : undefined;
		if (pages % 20 === 0) log(`  已列 ${pages} 页 / ${map.size} 个对象…`);
	} while (token);
	return map;
}

// ── 对象键 ↔ 资产 id ──

/** 对象键 → 资产 id（`assets/C00000123.png` → C00000123）；不符合命名返回 null */
export function idFromKey(key) {
	const base = key.split("/").pop() ?? "";
	const m = /^([A-Za-z]{1,12})(\d{8})\.([A-Za-z0-9]+)$/.exec(base);
	return m ? { id: `${m[1]}${m[2]}`, prefix: m[1], seq: Number(m[2]), ext: m[3].toLowerCase() } : null;
}

const EXT_CT = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml",
	mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
	mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
	txt: "text/plain", json: "application/json",
};

/** 扩展名 → {contentType, type(Capability)}；未知归 image（最保守：不会被当视频按秒计费） */
export function metaFromExt(ext) {
	const contentType = EXT_CT[ext] || "application/octet-stream";
	const type = contentType.startsWith("video/") ? "video" : contentType.startsWith("audio/") ? "audio" : contentType.startsWith("text/") ? "text" : "image";
	return { contentType, type };
}

/** 写 JSON 报告（--report=path） */
export function writeReport(path, obj) {
	if (!path) return;
	writeFileSync(path, JSON.stringify(obj, null, 2), "utf8");
	log(`报告已写入 ${path}`);
}

/** dry-run 收尾提示 */
export function dryRunTail(cmd) {
	console.log(`\n${"═".repeat(64)}`);
	console.log("这是 DRY-RUN，未对数据库/对象存储做任何写入。");
	console.log(`确认无误后真执行：  ${cmd} --apply`);
	console.log(`${"═".repeat(64)}\n`);
}
