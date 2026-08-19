---
name: qiji-billing-audit
description: 排查 Qiji 计费/积分问题：取 logId/taskId→查 credit_ops 流水 pre/post→对照 resolveModelCost 复核应扣→失败单核对两侧同退。触发词：计费排查、多扣/少扣积分、扣费对账、没退款、credit-ops、按秒计费不对。
---

# Qiji 计费 / 积分用量排查

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。下文路径均相对项目根。
> 详细字段语义与代码锚点见 [references/audit-notes.md](references/audit-notes.md)。

## 何时使用

- 用户反馈「积分对不上 / 多扣了 / 少扣了」「失败了没退款」。
- 渠道商门户/源站的消耗统计与预期不符。
- 新接渠道定真价前的小额真单对账；改动 credits/routes/models 计费代码后的回归核对。
- 历史上两类**真实亏损**案例即本 skill 的排查对象原型：
  1. **用户没扣、渠道商照扣**（第183轮根因：扣款在 `await dispatchGenerate` 之后，跨 await 竞态）；
  2. **按 30s 计费只发 15s**（第186/187轮 overseas 翻译器时长夹钳：按请求参数扣费、实发被静默砍半）。

## 前置检查

1. 确认服务端可达 + 拿到 ADMIN_TOKEN（dev 默认 `admin-dev`；生产在服务器 `.env` / 容器环境变量里）。

   ```powershell
   # PowerShell 5.1（本机 dev）
   Invoke-RestMethod -Uri "http://localhost:8787/health"
   ```

   ```bash
   # Git Bash（本机 dev）
   curl -s http://localhost:8787/health
   ```

2. 关键符号在位（改过代码后先确认没被移走）：用 Grep 工具查
   - `server/src/store/credits.ts` → `settle` / `reverse` / `selfHealCredits` / `listCreditOps` / `credit_ops`
   - `server/src/routes.ts` → `planBilling` / `chargeBilling` / `teamPayerFor`
   - `server/src/routes/admin.ts` → `/admin-api/credit-ops`
3. ⚠ **绝不整读 `CLAUDE.md`（502KB 撑爆上下文）**——查规则一律 Grep + `head_limit`。

## 步骤

主线：**取 logId/taskId → 查 credit_ops 流水 pre/post → 对照 resolveModelCost 复核 → 失败单核对两侧同退**。

### 1. 取 logId / taskId

首选管理端 `/admin` →「请求记录」页筛选（用户/模型/状态/时间），点开详情记下 logId（`log_` 前缀）与 taskId。
API 等价（参数实测在册：`user`/`userId`/`agentId`/`purpose`/`model`/`status`/`from`/`to`/`limit`/`offset`）：

```powershell
# PowerShell 5.1
Invoke-RestMethod -Uri "http://localhost:8787/admin-api/logs?status=failed&limit=20" -Headers @{ Authorization = "Bearer admin-dev" } | ConvertTo-Json -Depth 5
```

```bash
# Git Bash
curl -s -H "Authorization: Bearer admin-dev" "http://localhost:8787/admin-api/logs?status=failed&limit=20"
```

### 2. 查 credit_ops 流水（逐笔 pre/post）

端点注册在 `server/src/routes/admin.ts`：`GET /admin-api/credit-ops?accountId=&ref=&limit=`（ref 可传 logId **或** taskId；accountId 可传用户 id 或渠道商 id；limit 默认 200 上限 2000）。

```powershell
# PowerShell 5.1
Invoke-RestMethod -Uri "http://localhost:8787/admin-api/credit-ops?ref=<logId或taskId>" -Headers @{ Authorization = "Bearer admin-dev" } | ConvertTo-Json -Depth 6
```

```bash
# Git Bash
curl -s -H "Authorization: Bearer admin-dev" "http://localhost:8787/admin-api/credit-ops?ref=<logId或taskId>"
```

逐行核对：`accounts[]` 每项 `{kind:user|agent, id, delta, pre, post}`，**post 必须 = pre + delta**；`status` 应为 `done`（其余状态含义见 references）。`reason`：generate=扣款（含 /v1/batch 逐任务，流水里没有单独的 batch 事由）、refund/reconcile-refund=退款。

服务器侧直接查库（生产，1Panel 终端 / SSH，**Linux bash**；库在容器内 `/app/server/data/qiji.db`）：

```bash
docker exec qiji-server node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync("/app/server/data/qiji.db",{readOnly:true});console.log(JSON.stringify(db.prepare("SELECT * FROM credit_ops WHERE ref = ? ORDER BY seq DESC").all(process.argv[1]),null,1))' <logId或taskId>
```

（本机 PowerShell 5.1 下若要跑等价 node 脚本：**先把脚本落成临时 .mjs 文件再 `node 文件`**，绝不能把上面这条带内嵌双引号的 `node -e` 单行直接在 PS 5.1 执行——PS 5.1 会剥掉内嵌双引号必挂。）

### 3. 对照 resolveModelCost 复核应扣金额

计价规则单点在 `server/src/store/models.ts` `resolveModelCost`（Grep 定位后只读该函数及模型的 `routes` 段）：

- **按秒模型**（配了 `costField`）：`应扣 = round(perUnit × params[costField])`，perUnit 取值优先级：
  `渠道商档位覆盖(ovRule.costPerUnit) > 渠道商默认(override.costPerUnit) > 平台路由档(route.costPerUnit) > 模型基准(m.costPerUnit)`；
- **按次兜底**：`ovRule.cost ?? override.cost ?? route.cost ?? m.cost`；
- **routes 按档覆盖**：`when:{resolution:"720p"}` 之类命中即换 每秒价/upstreamModel——核对用户请求参数命中的是哪一档；
- **参考视频加权**（`server/src/refVideoBilling.ts`）：模型声明 `refVideoSecondsWeight>0` 且带视频素材时，
  `计费秒数 = duration + weight × Σ ceil(每条参考视频秒数)`（逐条向上取整，不足 1 秒算 1 秒）——planBilling 之前已写进计费参数副本，流水里看到的 delta 天然含这份；
- 客户端预估单一来源是 `src/lib/genParams.ts` `estimateCost`——客户端显示价与服务端实扣不一致时对照这两处口径。

### 4. 少扣 / 多扣 → 查 §9A 锁定规则

用 Grep 工具在 `CLAUDE.md` 里精准查（带 `head_limit`，勿整读），重点三条：

- **第183轮**：`chargeBilling` 扣款必须在 dispatch **之前**（搜 `chargeBilling`）；
- **第211轮**：统一定价——生成请求 settle agents 恒空、渠道商链不再双扣（搜 `统一定价`）;
- **第220轮**：`logCostFor` 无链记录取 `cost`=用户实扣（搜 `logCostFor`）。

### 5. 失败单核对「两侧同退」

失败/中断单应在 credit_ops 里找到对应 `refund` 或 `reconcile-refund` 行：

- 用户侧 `delta` 为正（退回），与扣款行数值相反；
- 带 `agentCosts` 的旧链式/发码/节点单：agents 段**同退**（缺一侧=第183轮修过的病灶复发）；
- 团队共享积分：退款必须退给 **payerId（团长池）**，不是消耗的团员（`billing.payerId` 随任务落盘，`server/src/store/tasks.ts` `setTaskBilling`）；
- 重启中断的在途单由 `server/src/reconcile.ts` 启动对账处理：④段有成品链接先转存救回标 success，救不回才 `reconcile-refund` 退款——「没退款」先确认单子是不是被救回成功了。

## 验证

排查结论落笔前逐项打勾：

1. 流水自洽：目标单每行 `post = pre + delta`，扣款行 status=done；
2. 金额复核：流水 delta 绝对值 == 按 resolveModelCost（含档位覆盖+参考视频加权）手算的应扣值；
3. 失败单：存在对应退款行，用户与渠道商两侧金额与扣款行一一相反，payerId 归位；
4. 无残留 `pending` 行（有则查服务端启动日志 `selfHealCredits` 的 healed/aborted/corrupt 输出）；
5. 余额终值：users.json/agents.json 当前余额与最后一行 post 对得上（余额真相在 JSON，见红线 8）。

## 踩坑红线

1. ⚠ **`chargeBilling` 必须在 dispatch 之前**（第183轮定式，`server/src/routes.ts` 注释明令勿挪回）——旧顺序 planBilling(查余额)→await 上游提交→扣款 的跨 await 窗口就是「用户没扣、渠道商照扣」亏损的根因。
2. ⚠ 异步任务登记 billing/退款依据是**实扣快照 `Charged`，不是 plan**——plan 只是「打算扣多少」，用 plan 会退一笔从未扣过的钱=凭空造币。
3. ⚠ `logCostFor` 口径（第220轮）：带 `agentCosts` 取对应那份（agent=本商/platform=根级）、**无链取 `cost`（用户实扣）**——勿回退成「无链=undefined」，否则门户/源站商属 KPI 恒 0。
4. ⚠ 统一定价 + 分发实扣是**原子包**（第211轮）：生成请求 settle agents 恒空，勿单独恢复任何链式双扣费代码。
5. ⚠ 翻译器参数一律经 `server/src/translators/paramPass.ts` 原样透传（第188/215轮）——任何 夹钳/就近取档/兜底改值 都是「按 30s 计费只发 15s」类亏损的温床。
6. ⚠ 参考视频**读不出时长=明确报错拒单**（不下单不扣费）——静默按 0=漏收、瞎按上限=多收，勿加兜底（refVideoBilling.ts 头注释锁定）。
7. ⚠ 团队共享模式退款退 **payerId（团长池）**、消耗统计记实际用户——两者别弄反（第172/183轮）。
8. ⚠ **余额真相在 users.json / agents.json**，credit_ops 只是流水（credits.ts 头注释刻意不迁整表）——对账发现不一致时以 JSON 余额为现实、以流水找差异原因，勿直接改 SQLite。
9. ⚠ relay 节点**勿启用 reconcileOnStartup**（会把仍在源站跑的任务当孤儿退款=用户白拿）；节点侧对账走 relay-ledger 清扫（第214轮）。
10. ⚠ `CLAUDE.md` 502KB 勿整读；credits.ts / routes.ts / models.ts 都较大，先 Grep 定位符号再只读相关段。
11. ⚠ 命令环境：PowerShell 5.1 不支持 `&&`；`curl` 在 PS 5.1 是 Invoke-WebRequest 别名（curl 命令一律标注 Git Bash 或改用 Invoke-RestMethod）；含内嵌双引号的 `node -e` 单行只能在 Git Bash / Linux bash 用，PS 5.1 先落临时脚本文件；服务器侧一律 Linux bash。

## 相关文件

| 用途 | 路径 |
|---|---|
| 结算/退款/自愈 + credit_ops 流水表 + listCreditOps | `server\src\store\credits.ts` |
| planBilling / chargeBilling / teamPayerFor（⚠ 在此，不在 teams.ts） | `server\src\routes.ts` |
| GET /admin-api/credit-ops、/admin-api/logs 系端点 | `server\src\routes\admin.ts` |
| resolveModelCost / ModelRoute 档位 / refVideoSecondsWeight | `server\src\store\models.ts` |
| 参考视频按秒加权（计费秒数合成） | `server\src\refVideoBilling.ts` |
| logCostFor 三视角（user/agent/platform）/ LogMeta.payerId | `server\src\store\logs.ts` |
| 启动对账：续轮询/孤儿救回/两侧同退退款 | `server\src\reconcile.ts` |
| setTaskBilling / billing.payerId / 退款钩子 | `server\src\store\tasks.ts` |
| Team 数据模型（共享/分发积分模式定义） | `server\src\store\teams.ts` |
| 客户端预估单一来源 estimateCost | `src\lib\genParams.ts` |
| §9A 锁定规则（⚠ 只 Grep 勿整读） | `CLAUDE.md` |
| 本 skill 详细字段语义/代码锚点 | `.claude\skills\qiji-billing-audit\references\audit-notes.md` |
