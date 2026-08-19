# qiji-billing-audit · 详细参考（2026-08-17 实测校验，第234轮代码时点）

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。路径相对项目根。
> 本文所有字段/签名均为本次 Read/Grep 实测，代码演进后以源码为准（先 Grep 符号名再读段落）。

## 1. credit_ops 流水表（server\src\store\credits.ts）

建表（模块加载即执行）：

```sql
CREATE TABLE IF NOT EXISTS credit_ops (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id     TEXT NOT NULL,
  created_at INTEGER NOT NULL,   -- epoch 毫秒
  reason    TEXT NOT NULL,       -- generate / refund / reconcile-refund 等（batch 仅存在于 SettleInput 注释，当前无写入点）
  ref       TEXT,                -- logId 或 taskId，回溯键
  payer_id  TEXT,                -- 实际扣款人（团队共享=团长）
  stats_user_id TEXT,            -- 消耗统计归属人（实际发起请求的用户）
  accounts  TEXT NOT NULL,       -- JSON: OpAccount[]
  status    TEXT NOT NULL        -- pending / done / healed / aborted / corrupt
);
-- 索引：idx_credit_ops_status / idx_credit_ops_ref / idx_credit_ops_created
```

`OpAccount = { kind: "user"|"agent", id, delta, pre, post }`（delta<0=扣、>0=退/加）。

状态语义：
- `pending`：写了意图还没改内存/落盘（正常情况瞬态）；
- `done`：结算完成（settle 末尾 UPDATE）；
- `healed` / `aborted` / `corrupt`：启动自愈 `selfHealCredits` 的三种处置——部分账户已到 post 则补齐（healed）、无任何账户到 post 则作废（aborted）、accounts JSON 损坏（corrupt）。余额被手工改动的账户保守跳过留痕。
- 裁剪：`pruneCreditOps(180)` 只删 180 天前的 done 行；pending/healed/aborted 永久保留供人工核。

`settle(input)`：**全通过才动钱，任一不足一分不动**（同步、Node 单线程无需锁）。返回 `{ok:true, charged: Charged}`，`Charged` 是**实扣快照**（opId/payerId/statsUserId/userAmount/agents）——异步任务据此登记 billing、失败按此原路退（⚠ 勿用 plan）。
`reverse(charged, reason="refund", ref?)`：按快照原路退回（同一原子通道）。

## 2. 查询端点（server\src\routes\admin.ts）

```
GET /admin-api/credit-ops?accountId=&ref=&limit=      （Bearer ADMIN_TOKEN）
```

- 实现即 `listCreditOps`（credits.ts）：ref 精确匹配；accountId 匹配 payer_id 或 accounts LIKE；limit 默认 200、上限 2000；按 seq 倒序。
- 返回行：`{opId, at, reason, ref, status, accounts[]}`。

请求记录端点（同文件）：`GET /admin-api/logs`（参数 `user`（用户名模糊）/`userId`/`agentId`（`__all`/`platform`/商id 三态）/`purpose`/`model`/`status`(success|failed|running)/`from`/`to`(epoch 毫秒)/`limit`/`offset`）、`/admin-api/logs/:id` 详情（四段报文）、`/facets`、`/summary`、`/export`。

## 3. 扣款时序（server\src\routes.ts，第183轮定式）

单次 /v1/generate 主路径（/v1/batch 每任务同构）：

```
refVideoBillingParams(md, params, inputs)   ← 参考视频加权先合成计费参数副本
→ planBilling(user, md, rb.params)          ← 只算不扣（含 402 预检语义）
→ startLog(... cost, payerId ...)
→ chargeBilling(user, plan, log.id)         ← 同步块内校验+实扣（settle）★必须在 dispatch 之前
→ await dispatchGenerate(body, log.id)      ← 之后才发上游
→ 同步失败 reverse / 异步按 Charged 快照 setTaskBilling
```

- `teamPayerFor(user)` 定义在 **routes.ts**（非 store/teams.ts）：shared 团队的非团长成员 → payer=团长（共享池=团长余额）；`chargeCreditsAs(payerId, statsUserId, amount)` 钱扣付款人、统计记消耗人。
- `startLog` 的 `payerId` 仅在 payer≠本人时写入；LogMeta 无 payerId 的存量单退款回退本人（旧行为）。
- 节点（relay）请求：源站落笔定式 `cost:0 + agentCosts:[{id:商, cost:池实扣}] + ownerId:商 + userId:"nu:..."`（第214轮，勿改）。

## 4. resolveModelCost（server\src\store\models.ts）

实测函数体（签名 `resolveModelCost(m, params?, override?)`）：

```
route  = matchRoute(m, params)                    // 平台 routes 按 when:{参数:值} 精确命中
ovRule = override.rules 里 when 全匹配的那条        // 渠道商按档覆盖（仅名下用户生效）
if (m.costField) {
  perUnit = ovRule.costPerUnit ?? override.costPerUnit ?? route.costPerUnit ?? m.costPerUnit ?? 0
  unit    = max(0, Number(params[m.costField]) || 0)
  if (perUnit>0 && unit>0) return round(perUnit * unit)      // 按秒（或按字段单位）
}
return ovRule.cost ?? override.cost ?? route.cost ?? m.cost   // 按次兜底
```

- 兜底 `cost` 的定价惯例=「默认按最高」（每秒价 × 该模型最长时长，第134轮补充2）。
- ⚠ 语义须与客户端 `src\lib\genParams.ts` `estimateCost(model, params, refVideoSeconds)` 及 catalog 逐档投影三方一致（函数注释锁定）。

## 5. 参考视频加权（server\src\refVideoBilling.ts，第140轮）

- 触发条件：模型 `refVideoSecondsWeight > 0` 且配了 `costField` 且请求带视频素材且基础秒数 >0；否则原样返回（零开销）。
- 公式：`计费秒数 = params[costField] + weight × Σ ceil(每条参考视频秒数)`（逐条向上取整，不足 1 秒算 1 秒）。
- 实现方式：planBilling **之前**把合成秒数写进**计费参数副本**（原 params 不动、发上游不受影响）→ 售价/结算链/档位路由价/402 预检/失败退款全自动包含。
- 时长三级来源：资产台账 duration_ms 缓存 → 服务端内存字节解析 → HTTP Range 远端探测（探到回填台账）。
- ⚠ 读不出时长（非 mp4/mov、网络失败）→ **明确报错拒单**（不下单不扣费）；`*.localhost` webview 伪域不作探测源。
- relay 节点的目录预估价**不含**参考视频加权（实扣为准，第214轮已知边界）。

## 6. logCostFor 三视角（server\src\store\logs.ts）

```
view 缺省 / kind=user  → l.cost                        （用户实扣/售价）
kind=agent(agentId)    → 带 agentCosts：取本商那份；无链：l.cost（第220轮）
kind=platform          → 带 agentCosts：取根级实扣；无链：l.cost（第220轮补充）
```

发码日志（logCodeIssue）无 userId 只有 agentCosts；作废退回记负数 cost（门户统计天然净额）。

## 7. 启动对账（server\src\reconcile.ts）

`reconcileOnStartup`（index.ts 启动后异步调；relay 角色跳过）：
1. 待办任务：能续则 `resumeVideoPolling`，不能续 `failTask`（触发退款钩子，billing 已随任务落盘）；
2. 孤儿 running 日志：④段有成品链接 → `rehostVideo` 转存救回标 success（**不退款**）；救不回 → `settle({reason:"reconcile-refund", payerId: l.payerId ?? l.userId, userAmount: -refund, agents: agentCosts 取负})` **两侧同退**，错误文案带「已退回 N 积分」。
3. `selfHealCredits` 在 reconcileOnStartup **之前**跑（index.ts 顺序）。

排查「用户说失败没退款」时先看：该单是不是被 ② 救回成了 success。

## 8. 常用 Grep 定位（用 Grep 工具，勿 shell grep 整读）

| 要找什么 | pattern | path |
|---|---|---|
| 结算/退款/自愈 | `export function (settle\|reverse\|selfHealCredits)` | `server/src/store/credits.ts` |
| 扣款时序注释 | `chargeBilling` | `server/src/routes.ts` |
| 计价函数 | `function resolveModelCost` | `server/src/store/models.ts` |
| 某模型档位 | `<模型id 或 upstreamModel 片段>` | `server/src/store/models.ts` |
| 流水端点 | `credit-ops` | `server/src/routes/admin.ts` |
| §9A 计费规则 | `第183轮\|统一定价\|logCostFor` + head_limit | `CLAUDE.md` |

## 9. 与清单记载不符处（本次实测更正）

- `teamPayerFor` 在 `server\src\routes.ts`（约 116 行处），**不在** `store\teams.ts`（后者只有 Team 数据模型与成员/邀请/结算原语）。
- `/admin-api/credit-ops` 端点注册在 `server\src\routes\admin.ts`（非 routes.ts）。
