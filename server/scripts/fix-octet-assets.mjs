/**
 * 修复「Content-Type 落成 octet-stream / 后缀落成 .bin」的存量资产。
 *
 * 背景（2026-08-03）：出海营渠道成片托管站（MinIO）返回 `binary/octet-stream`，
 * rehostVideo 照单全收 → extFor 映射不到 → OSS 键成 `video00024621.bin`、台账
 * content_type=binary/octet-stream，公网直链以 octet-stream 服务（webview 拒播）。
 * 代码防御已加（translators/contentType.ts resolveContentType）；本脚本修存量。
 *
 * 做法（每条命中资产）：
 *   ① 从桶里 GET 原对象字节（按台账 oss_key，不走公网链）
 *   ② **魔数嗅探**真实类型（mp4/webm/png/jpg/gif/webp/mp3/wav/ogg），嗅不出按
 *      台账 type 列兜底（video→video/mp4 …），仍无法判定则跳过并报告
 *   ③ PUT 到**新对象键**（同路径、后缀换成真实 ext）并带正确 ContentType
 *   ④ 更新台账行：content_type / oss_key / url（url 按旧串内替换键，保留原 host）
 *   ⑤ **旧对象保留不删**——已下发到客户端/任务记录里的旧 .bin 直链继续可用
 *
 * ⚠ 必须在服务器上、对实时台账跑（同 reconcile.mjs 的告诫）。
 *
 * 用法（容器内 /app/server）：
 *   node scripts/fix-octet-assets.mjs            # dry-run：只列出将要修的，不动任何东西
 *   node scripts/fix-octet-assets.mjs --apply    # 真执行
 *   可选：--id=video00024621                     # 只修指定 id（可逗号分隔多个）
 */
import { parseArgs, openDb, ossConfig, s3Client, log, warn, section, human, dryRunTail } from "./_p0lib.mjs";

const { apply, opts } = parseArgs();
const ONLY_IDS = opts.id ? new Set(String(opts.id).split(",").map((s) => s.trim()).filter(Boolean)) : null;

// ── 魔数嗅探（字节为准，比上游头可信） ──
function sniff(buf) {
	if (buf.length < 12) return null;
	const ascii = (off, len) => buf.subarray(off, off + len).toString("latin1");
	if (ascii(4, 4) === "ftyp") return { ct: "video/mp4", ext: "mp4" };
	if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ct: "video/webm", ext: "webm" };
	if (buf[0] === 0x89 && ascii(1, 3) === "PNG") return { ct: "image/png", ext: "png" };
	if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ct: "image/jpeg", ext: "jpg" };
	if (ascii(0, 4) === "GIF8") return { ct: "image/gif", ext: "gif" };
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { ct: "image/webp", ext: "webp" };
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return { ct: "audio/wav", ext: "wav" };
	if (ascii(0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { ct: "audio/mpeg", ext: "mp3" };
	if (ascii(0, 4) === "OggS") return { ct: "audio/ogg", ext: "ogg" };
	return null;
}

/** 嗅探失败时按台账 type 列兜底 */
const TYPE_FALLBACK = { video: { ct: "video/mp4", ext: "mp4" }, audio: { ct: "audio/mpeg", ext: "mp3" }, image: { ct: "image/png", ext: "png" } };

const db = openDb();
section("扫描台账");
let rows = db
	.prepare("SELECT id, type, content_type, oss_key, url, storage FROM assets WHERE content_type LIKE '%octet-stream%' AND purged_at IS NULL")
	.all();
if (ONLY_IDS) rows = rows.filter((r) => ONLY_IDS.has(r.id));
log(`命中 ${rows.length} 条 octet-stream 资产${ONLY_IDS ? `（按 --id 过滤）` : ""}`);
if (rows.length === 0) {
	log("无事可做。");
	process.exit(0);
}
for (const r of rows) log(`  ${r.id}  type=${r.type}  content_type=${r.content_type}  key=${r.oss_key ?? "(无键)"}`);

const o = ossConfig();
const client = await s3Client();
const { GetObjectCommand, PutObjectCommand, HeadObjectCommand } = await import("@aws-sdk/client-s3");

const stmtFix = db.prepare("UPDATE assets SET content_type = ?, oss_key = ?, url = ? WHERE id = ?");

section(apply ? "执行修复" : "试算（dry-run，不动任何东西）");
let fixed = 0, skipped = 0;
for (const r of rows) {
	if (!r.oss_key) {
		warn(`${r.id} 无对象键（内存态记录），跳过`);
		skipped += 1;
		continue;
	}
	// ① 取字节
	let buf;
	try {
		const g = await client.send(new GetObjectCommand({ Bucket: o.bucket, Key: r.oss_key }));
		buf = Buffer.from(await g.Body.transformToByteArray());
	} catch (e) {
		warn(`${r.id} 取对象失败（${e?.name || e?.message}），跳过——若对象确实不存在应由 reconcile.mjs 打墓碑`);
		skipped += 1;
		continue;
	}
	// ② 判型：嗅探优先，type 列兜底
	const sniffed = sniff(buf);
	const target = sniffed ?? TYPE_FALLBACK[r.type];
	if (!target) {
		warn(`${r.id} 嗅探失败且 type=${r.type} 无兜底，跳过（需人工判定）`);
		skipped += 1;
		continue;
	}
	if (!sniffed) warn(`${r.id} 魔数未识别，按 type=${r.type} 兜底为 ${target.ct}`);
	// ③ 新键 = 旧键换后缀；旧键无后缀或后缀已正确则原键重传（纯元数据修复）
	const newKey = r.oss_key.replace(/\.[A-Za-z0-9]+$/, "") + "." + target.ext;
	const newUrl = r.url && r.url.includes(r.oss_key) ? r.url.replace(r.oss_key, newKey) : r.url;
	log(`${r.id}  ${human(buf.length)}  ${r.content_type} → ${target.ct}${sniffed ? "（嗅探）" : "（兜底）"}`);
	log(`  键 ${r.oss_key} → ${newKey}${newKey === r.oss_key ? "（原键重传，仅修元数据）" : ""}`);
	if (!apply) continue;
	// 防覆盖：新键已存在（且不是原键）说明修过或撞车——直接复用已存在对象
	if (newKey !== r.oss_key) {
		try {
			await client.send(new HeadObjectCommand({ Bucket: o.bucket, Key: newKey }));
			log(`  新键已存在，跳过上传只更新台账`);
		} catch {
			await client.send(new PutObjectCommand({ Bucket: o.bucket, Key: newKey, Body: buf, ContentType: target.ct }));
		}
	} else {
		await client.send(new PutObjectCommand({ Bucket: o.bucket, Key: newKey, Body: buf, ContentType: target.ct }));
	}
	stmtFix.run(target.ct, newKey, newUrl, r.id);
	log(`  ✅ 台账已更新：url=${newUrl}（旧对象保留不删）`);
	fixed += 1;
}

section("汇总");
log(`修复 ${fixed} 条，跳过 ${skipped} 条`);
if (!apply) dryRunTail("node scripts/fix-octet-assets.mjs");
