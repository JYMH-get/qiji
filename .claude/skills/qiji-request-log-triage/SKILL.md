---
name: qiji-request-log-triage
description: Qiji 请求记录排障：按四段报文定位问题（③实发上游/④上游回执）、errorScrub 擦除语义、报文3天/索引30天保留期、清日志脚本停服红线。触发词：请求记录排障、上游报错、参数没透传、错误文案没渠道名、日志没报文。
---

# Qiji 请求记录排障（request-log-triage）

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。正文路径均相对项目根。

## 何时使用

- 用户/渠道商报某次生成失败或结果异常，要查真实原因。
- 怀疑「我方参数没透传上游」「上游报错」「上游状态词没覆盖导致任务一直 running」。
- 有人发现「错误文案里看不到渠道名/域名」，疑心是 bug。
- 需要清理渠道商归属的请求记录（`purge-agent-logs.mjs`）。
- 记录太旧、详情页显示「已清除」，判断还能查到什么。

## 核心心法（先读这段）

**四段报文**（`server\src\store\logs.ts` 的 `LogDetail`，持久层为 SQLite `server\data\qiji.db` 的 `logs` + `log_details` 两表）：

| 段 | 字段名 | 内容 |
|---|---|---|
| ① | `requestHeaders` / `request` | 用户 → 管理端 的请求头（敏感值已脱敏）与完整请求体（base64 已截断） |
| ② | `response` | 管理端 → 用户 的完整响应/结果 |
| ③ | `upstreamRequest` | 管理端 → 上游 的请求体 |
| ④ | `upstreamResponse` | 上游 → 管理端 的原始响应 |

- **排障看 ③④ 段原文**。用户可见错误（②段/任务 error）已被 `errorScrub.ts` 的 `scrubChannelInfo` 统一擦除：完整链接→「（链接已隐藏）」、上游域名→「（已隐藏）」、品牌词→「渠道」（与当前模式名相同的词经占位符保护不擦）。**「错误文案不含渠道名」= errorScrub 正常工作，不是 bug。** ③④ 段刻意不经擦除（errorScrub.ts 头部注释明写「仅源站管理端可见，保留全量供排障」）——看 ③ 段 URL 即知发到了哪家渠道哪个端点，看 ④ 段即知上游真实回执。
- **保留策略**（第222轮定稿，logs.ts 常量实锤）：报文（①②③④详情）只留 **3 天**（`DETAIL_KEEP_MS`），索引 **30 天**（`META_KEEP_MS`，超 30 天整天清除）。超 3 天的记录带 `detailPruned` 标记 = 只剩索引，**别浪费时间找报文**；成片链接完成时已预抽进索引 `resultLink`，列表/导出仍可见。`running` 状态的记录不清详情（启动对账要读 ④ 段救回视频）。

## 前置检查

1. 先确认记录年龄：>3 天无报文、>30 天连索引都无——直接告知无从回溯，不要空翻。
2. 管理端入口可用：浏览器开 `<服务端地址>/admin`（ADMIN_TOKEN 登录）→「请求记录」页。
3. 走 API 时确认 ADMIN_TOKEN 在手（本机 dev 在 `server\.env`；生产在服务器环境配置）。

## 步骤

### 1. 定位记录（管理端 UI，首选）

「请求记录」页：左上**范围下拉**（「源站（平台直属）」/ 各渠道商，第168轮）+ 时间/用户/步骤/模型筛选 → 点行开详情，四段依次展示。渠道商详情页内也有「请求记录」子页（同数据另一入口）。

### 2. 定位记录（API，可选）

Git Bash：

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8787/admin-api/logs?limit=30&offset=0"
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "http://localhost:8787/admin-api/logs/<logId>"   # 详情四段
```

PowerShell 5.1（⚠ `curl` 在 PS 5.1 是 Invoke-WebRequest 别名，勿直接抄 bash 写法）：

```powershell
Invoke-RestMethod -Uri "http://localhost:8787/admin-api/logs?limit=30" -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" }
Invoke-RestMethod -Uri "http://localhost:8787/admin-api/logs/<logId>" -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" }
```

范围参数（`server\src\routes\admin.ts` `logScope` 实锤）：`?userId=<id>`=单用户视图；`?agentId=__all`=全部；`?agentId=platform` 或缺省=源站直属；`?agentId=<商id>`=该渠道商。另有 `/admin-api/logs/facets|summary|export` 同参。

### 3. 判读四段

- **③ 段**：实发上游的 URL/body——对照 ① 段判定客户端参数是否原样透传（§9 禁夹钳），以及发到了哪家渠道。
- **④ 段**：上游真实回执——上游报错原文、状态词。任务长期 running 多半是上游回了文档未公布的状态词（翻译器防御式状态族对未知词不终态，属设计）。
- **②段错误文案**已经擦除，要真因一律回 ③④ 段，勿按擦除后的中性文案下结论。

### 4. 清理渠道商归属日志（如需）

脚本按自身位置定位库文件（`server\data\qiji.db`），在 `server\` 目录下跑。默认 dry-run 只读打开、绝无写入；无参 = 只列归属分布：

```bash
# 本机（Git Bash）或服务器（Linux bash）
cd server
node scripts/purge-agent-logs.mjs                                  # 只列归属分布
node scripts/purge-agent-logs.mjs --owner=<商id> --before=2026-08-01   # dry-run 预览
node scripts/purge-agent-logs.mjs --owner=<商id> --apply           # 真删（必须先停服，见红线）
```

`--apply` 自动备份 `qiji.db`（`.bak-purge-<日期>`）+ 单事务内 logs / log_details 同删；`--all-agents` 清全部渠道商归属；源站直属（owner=''）脚本拒绝触碰。

生产环境（第198/222/226轮记载）：⚠ `/opt/qiji` 是 1Panel 显示的**容器内**路径，宿主机上并不存在——数据库宿主机真实路径经 `docker inspect qiji-server` 查 `Mounts` 定位后停服跑；或按第198轮「跑完立刻重启」语义：`docker exec qiji-server node /app/server/scripts/purge-agent-logs.mjs ...` 后**立即** `docker compose restart`。

## 验证

- 3 天内记录：详情页四段可见 ③④ 原文。
- 超期记录：列表仍在、详情显示「已清除」（`detailPruned`）——属预期，非丢数据。
- purge 后：重启服务端，管理端该商记录数归零、源站直属数不变；实删条数与 dry-run 预览一致；`qiji.db.bak-purge-*` 备份在。

## 踩坑红线

- ⚠ **`purge-agent-logs.mjs` 必须停服后跑**（或跑完立刻重启）——logs 索引常驻服务端内存，进程活着时删库，被删的行会在下次落盘被内存回写（脚本头部注释同款警告）。
- 「错误文案不含渠道名」**不是 bug**——errorScrub 正常工作，勿去「修复」；真因看 ③④ 段。
- 超 3 天只剩索引（`detailPruned`）——别浪费时间找报文；超 30 天连索引都无。
- ③④ 段含上游真实域名等渠道信息，仅源站管理端可见（门户端点已剥）——勿把原文转发给渠道商/用户。
- 命令环境：PowerShell 5.1 不支持 `&&`；含内嵌双引号的 `node -e` 单行在 PS 5.1 必挂（内嵌双引号被剥），要跑就先落成临时 `.mjs` 文件再 `node` 执行；服务器侧命令一律 Linux bash。

## 相关文件

| 用途 | 路径 |
|---|---|
| 日志存储与保留策略（四段字段、DETAIL_KEEP_MS/META_KEEP_MS、detailPruned、resultLink） | `server\src\store\logs.ts` |
| 渠道信息擦除（scrubChannelInfo、BRAND_TOKENS/HOST_TOKENS、模式名占位符保护） | `server\src\errorScrub.ts` |
| 日志 API（/admin-api/logs 及 facets/summary/export/:id、logScope 范围解析） | `server\src\routes\admin.ts` |
| 管理端「请求记录」页（范围下拉 + 详情四段 UI） | `server\src\admin\index.html` |
| 渠道商日志清理脚本（默认 dry-run、--apply 自动备份） | `server\scripts\purge-agent-logs.mjs` |
| SQLite 库（logs + log_details 两表） | `server\data\qiji.db` |
