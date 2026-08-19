/**
 * 清理渠道商归属的请求记录（logs + log_details 同步删除）。
 *
 * 用法（在 server/ 目录下）：
 *   node scripts/purge-agent-logs.mjs                     # dry-run：只统计将删除什么，不动数据
 *   node scripts/purge-agent-logs.mjs --owner=ag_xxx      # 只清某个渠道商
 *   node scripts/purge-agent-logs.mjs --all-agents        # 清全部渠道商归属的记录（不含源站直属）
 *   node scripts/purge-agent-logs.mjs --before=2026-08-01 # 追加时间条件：只删该日期（UTC）之前的
 *   ... --apply                                           # 真执行（默认 dry-run）
 *
 * ⚠ 必须停掉服务端再跑（或跑完立刻重启）——请求记录索引全部常驻服务端内存，
 *   进程活着时删库，被删的行会在下次落盘时被内存回写。
 * ⚠ 只删渠道商归属（owner != ''）的记录；源站直属记录（owner=''）本脚本永不触碰。
 * ⚠ 建议先备份 data/qiji.db。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = join(here, "..", "data", "qiji.db");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const allAgents = args.includes("--all-agents");
const owner = (args.find((a) => a.startsWith("--owner=")) || "").slice("--owner=".length) || null;
const before = (args.find((a) => a.startsWith("--before=")) || "").slice("--before=".length) || null;

if (!existsSync(dbPath)) { console.error(`找不到数据库：${dbPath}`); process.exit(2); }
if (!owner && !allAgents) {
	console.log("未指定范围。先看归属分布，再用 --owner=<id> 或 --all-agents 指定要清的范围：\n");
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const rows = db.prepare("SELECT CASE WHEN owner='' THEN '(源站直属·不可清)' ELSE owner END AS o, COUNT(*) n FROM logs GROUP BY owner ORDER BY n DESC").all();
	for (const r of rows) console.log(`  ${String(r.o).padEnd(24)} ${r.n} 条`);
	db.close();
	process.exit(0);
}
if (owner === "" || owner === "platform") { console.error("拒绝：源站直属记录不在本脚本射程内。"); process.exit(2); }
if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before)) { console.error("--before 须为 YYYY-MM-DD"); process.exit(2); }

// 条件：渠道商归属 +（可选）时间上限。started_at 为 ISO 串，字典序即时间序。
const conds = [owner ? "owner = ?" : "owner != ''"];
const params = owner ? [owner] : [];
if (before) { conds.push("started_at < ?"); params.push(before); }
const where = conds.join(" AND ");

const db = new DatabaseSync(dbPath, { readOnly: !apply }); // dry-run 只读打开，绝无写入可能
const hit = db.prepare(`SELECT owner, COUNT(*) n FROM logs WHERE ${where} GROUP BY owner ORDER BY n DESC`).all(...params);
const total = hit.reduce((s, r) => s + Number(r.n), 0);
console.log(`匹配 ${total} 条（范围：${owner ? `商 ${owner}` : "全部渠道商"}${before ? `，${before} 之前` : ""}）：`);
for (const r of hit) console.log(`  ${String(r.owner).padEnd(24)} ${r.n} 条`);

if (!apply) { console.log("\ndry-run 未删除任何数据。确认无误后加 --apply 真执行（先停服务端！）。"); db.close(); process.exit(0); }
if (!total) { console.log("无可删记录。"); db.close(); process.exit(0); }

// 真执行：先备份，再一个事务里 logs + 对应 log_details 同删
const bak = dbPath + ".bak-purge-" + new Date().toISOString().slice(0, 10);
if (!existsSync(bak)) { copyFileSync(dbPath, bak); console.log(`\n已备份：${bak}`); }
db.exec("BEGIN");
const dDetails = db.prepare(`DELETE FROM log_details WHERE id IN (SELECT id FROM logs WHERE ${where})`).run(...params);
const dLogs = db.prepare(`DELETE FROM logs WHERE ${where}`).run(...params);
db.exec("COMMIT");
console.log(`已删除：索引 ${dLogs.changes} 条、详情 ${dDetails.changes} 条。`);
console.log("⚠ 若服务端删除期间在运行：请立刻重启服务端，否则内存里的旧索引会把部分记录写回来。");
db.close();
