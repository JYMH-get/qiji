#!/usr/bin/env node
/**
 * Qiji 每日使用分析导出（本机执行，经 ssh 别名 `qiji` 取数）。
 *
 *   node server/scripts/ops/daily-usage.mjs [--days 14] [--out <目录>]
 *
 * 取数：服务器上 curl 127.0.0.1:8787/admin-api/stats（ADMIN_TOKEN 从 /opt/qiji/server/.env 现读，
 * 只在远端 shell 内使用，不落本地、不进输出）。
 * 产出三份同名文件：<out>/usage-<今日>.json（原始）/.csv（逐日明细，Excel 可直开）/.md（人读摘要）。
 * ⚠ 请求日志索引服务端只留 30 天，--days 超过 30 天的部分会是 0。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const days = Math.max(1, Math.min(30, Number(arg("--days", 14)) || 14));
const outDir = arg("--out", "ops-reports");
const HOST = arg("--host", "qiji");

// 远端脚本走 stdin（ssh HOST bash -s），避免 shell 引号层层转义；token 只在远端 shell 内存在
const remoteScript = `set -e
T=$(sed -n 's/^ADMIN_TOKEN=//p' /opt/qiji/server/.env | head -1 | tr -cd 'A-Za-z0-9_.:@=+/-')
if [ -z "$T" ]; then echo "ADMIN_TOKEN 未配置" >&2; exit 1; fi
curl -sS -m 30 -H "Authorization: Bearer $T" "http://127.0.0.1:8787/admin-api/stats?days=${days}"`;

let stats;
try {
  const raw = execFileSync("ssh", ["-o", "BatchMode=yes", HOST, "bash", "-s"], {
    input: remoteScript, encoding: "utf8", maxBuffer: 64 << 20,
  });
  stats = JSON.parse(raw);
} catch (e) {
  console.error("取数失败：", e.stderr?.toString?.() || e.message);
  console.error("排查：`ssh qiji true` 能否免密；/opt/qiji/server/.env 里 ADMIN_TOKEN 是否还在；容器是否在跑。");
  process.exit(1);
}

const { users: U, requests: R } = stats;
const today = new Date().toISOString().slice(0, 10);
const rows = R.reqByDay.map((d, i) => ({
  date: d.date, total: d.total, success: d.success, failed: d.failed,
  failRate: d.total ? +(d.failed / d.total * 100).toFixed(2) : 0,
  credits: R.creditByDay[i]?.credits || 0,
}));
const last = rows.at(-1), prev = rows.at(-2);
const win = rows.slice(-7);
const avg = (k) => win.length ? Math.round(win.reduce((s, r) => s + r[k], 0) / win.length) : 0;
const delta = (a, b) => (b ? `${a >= b ? "+" : ""}${((a - b) / b * 100).toFixed(1)}%` : "—");
const n = (x) => (x ?? 0).toLocaleString("en-US");

mkdirSync(outDir, { recursive: true });
const base = join(outDir, `usage-${today}`);
writeFileSync(`${base}.json`, JSON.stringify(stats, null, 2), "utf8");
writeFileSync(`${base}.csv`,
  "﻿日期,请求总数,成功,失败,失败率%,消耗积分\n" +
  rows.map((r) => [r.date, r.total, r.success, r.failed, r.failRate, r.credits].join(",")).join("\n") + "\n", "utf8");

const md = `# Qiji 使用分析 · ${today}

数据截至 ${stats.generatedAt}（UTC），窗口 ${days} 天。

> 逐日按 **UTC 日**切分；「今日」这一行通常是**未走完的部分日**，与「昨日」直接比会偏低——看趋势请以「近 7 日均值」列为准。

## 今日概览

| 指标 | 今日 | 昨日 | 环比 | 近 7 日均值 |
|---|--:|--:|--:|--:|
| 请求总数 | ${n(last.total)} | ${n(prev?.total)} | ${delta(last.total, prev?.total)} | ${n(avg("total"))} |
| 成功 | ${n(last.success)} | ${n(prev?.success)} | ${delta(last.success, prev?.success)} | ${n(avg("success"))} |
| 失败 | ${n(last.failed)} | ${n(prev?.failed)} | ${delta(last.failed, prev?.failed)} | ${n(avg("failed"))} |
| 失败率 | ${last.failRate}% | ${prev?.failRate ?? "—"}% | — | ${(win.reduce((s, r) => s + r.failRate, 0) / win.length).toFixed(2)}% |
| 消耗积分 | ${n(last.credits)} | ${n(prev?.credits)} | ${delta(last.credits, prev?.credits)} | ${n(avg("credits"))} |

${last.failRate > 10 ? `> ⚠ 今日失败率 ${last.failRate}% 偏高，去管理端「请求记录」按 status=failed 筛一下上游报错。\n` : ""}
## 用户

- 总数 **${n(U.total)}**（启用 ${n(U.enabled)} / 停用 ${n(U.disabled)}），已绑账号 ${n(U.bound)} / 未绑 ${n(U.unbound)}
- 积分池：在用户手上 **${n(U.totalCredits)}**，累计已消耗 **${n(U.totalSpentAll)}**
- 近 7 日新注册：${U.regByDay.slice(-7).map((r) => `${r.date.slice(5)} ${r.count}`).join(" · ")}

### 消耗 Top
| 用户 | 累计消耗 | 余额 |
|---|--:|--:|
${U.topSpenders.map((s) => `| ${s.name} | ${n(s.spent)} | ${n(s.credits)} |`).join("\n")}

## 用途分布（窗口内累计，Top 10）

| 用途 | 次数 | 占比 |
|---|--:|--:|
${R.byPurpose.map((p) => `| ${p.label} | ${n(p.count)} | ${(p.count / R.totalRequests * 100).toFixed(1)}% |`).join("\n")}

## 模型调用（Top 10）

| 模型 | 次数 |
|---|--:|
${R.byModel.map((m) => `| ${m.key} | ${n(m.count)} |`).join("\n")}

## 逐日明细

| 日期 | 总数 | 成功 | 失败 | 失败率 | 消耗积分 |
|---|--:|--:|--:|--:|--:|
${rows.map((r) => `| ${r.date} | ${n(r.total)} | ${n(r.success)} | ${n(r.failed)} | ${r.failRate}% | ${n(r.credits)} |`).join("\n")}

---
日志索引服务端保留 30 天，更早数据不可回溯。请求记录报文只留 3 天。
`;
writeFileSync(`${base}.md`, md, "utf8");

console.log(`✔ 已导出 ${base}.{json,csv,md}`);
console.log(`  今日 ${n(last.total)} 次请求（失败率 ${last.failRate}%），消耗 ${n(last.credits)} 积分，环比 ${delta(last.credits, prev?.credits)}`);
