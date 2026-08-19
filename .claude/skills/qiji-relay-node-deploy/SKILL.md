---
name: qiji-relay-node-deploy
description: 部署 Qiji 渠道节点（NODE_ROLE=relay 渠道商自部署）：源站生成 ank- 节点密钥、节点机配 .env 启动、「源站连接」自检、跑单对账（两侧金额恒等）。触发词：渠道节点、relay 部署、节点密钥、ank、渠道商独立部署、节点对账、重置节点密钥。
---

# Qiji 渠道节点（relay）部署与对账

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。正文路径均相对项目根。
> **权威手册：`docs\渠道节点部署手册.md`**（已完整覆盖前置条件/部署/自检/计费对账/边界）。
> 本 skill 只固化流程主线与红线，细节一律指回手册。

## 何时使用

- 渠道商要独立部署自己的「渠道节点」（同一套服务端、NODE_ROLE=relay），或给他们做部署支持。
- 源站运营侧：生成/重置 `ank-` 节点密钥、查看节点消耗、排查节点「未连通」。
- 节点上线后的计费对账（节点本地扣费 vs 源站积分池实扣）。
- 不适用：源站自身部署（用 `qiji-pack-and-deploy-server` skill）；接新上游渠道（用 `qiji-add-upstream-channel`）。

## 前置检查

| 项 | 要求 |
|---|---|
| 节点服务器 | 可跑 Node.js 24+ 的 Linux/Windows，**公网可达**（客户端要连它） |
| 源站地址 | **源站必须公网可达**（素材直链/302 兜底指向源站） |
| 节点密钥 | `ank-` 开头；源站管理端「渠道商详情 → 渠道节点」生成，或渠道商门户「渠道节点」页自助生成 |
| 积分池 | 该商在源站的积分余额 >0（池余额=节点服务上限，为 0 时全部生成请求 402） |
| 不需要的 | 节点**不需要配 OSS**、**不接触**任何上游 AI 渠道密钥（手册 §0） |

架构速记（细节见 `server\src\relay.ts` 头注释）：节点本地拥有用户库/积分发行/团队/兑换码/请求日志；目录/生成/任务/素材全部经 `SOURCE_URL` + `SOURCE_NODE_KEY` 转发源站；本地按**源站回传的实扣金额**镜像扣本地用户——金额恒等。

## 步骤

### 1. 源站生成节点密钥（源站运营）

管理端「渠道商 → 详情 → 渠道节点」点生成，或让商在门户「渠道节点」页自助生成。得到 `ank-` 密钥。
（服务端实现：`server\src\store\agents.ts` 的 `regenerateAgentNodeKey`，密钥 = `ank-` + 48 位 hex。）

### 2. 节点机部署（服务器侧，Linux bash）

```bash
# ① 拿到与源站同一套的服务端代码，装依赖
cd server && npm i

# ② 配置 .env（模板见 server/.env.example 的 relay 注释段）
# PORT=8787
# ADMIN_TOKEN=换成你自己的强口令
# NODE_ROLE=relay
# SOURCE_URL=https://源站地址
# SOURCE_NODE_KEY=ank-xxxxxxxx

# ③ 启动（生产用 pm2/systemd 常驻）
npm run dev
```

角色判定实锤：启动日志出现 **`Qiji 渠道节点（relay）已启动`**（`server\src\index.ts`）即角色正确；打出的是源站启动语则 `NODE_ROLE` 没生效。

### 3. 对接自检（手册 §3 全清单，这里是主线）

打开节点 `/admin`（用节点自己的 ADMIN_TOKEN 登录），看顶部「**源站连接**」条：

- `已连通` + 显示商名与**积分池余额** → 对接成功；
- `未连通` → 依次核对：SOURCE_URL 可达、SOURCE_NODE_KEY 未被重置、该商账号未被源站停用。

命令行等价自检（任选）：

```bash
# Git Bash / Linux bash —— 直接用 ank- 密钥打源站
curl -s -H "Authorization: Bearer ank-xxxxxxxx" https://源站地址/v1/node/me

# 节点本机健康 + 源站连接状态（/admin-api/relay/status 仅 relay 模式存在）
curl -s http://localhost:8787/health
curl -s -H "Authorization: Bearer <节点ADMIN_TOKEN>" http://localhost:8787/admin-api/relay/status
```

```powershell
# PowerShell 5.1 等价（curl 在 PS5.1 是 Invoke-WebRequest 别名，勿直接抄 bash 写法）
Invoke-RestMethod -Uri "https://源站地址/v1/node/me" -Headers @{ Authorization = "Bearer ank-xxxxxxxx" }
```

### 4. 开号试跑（手册 §3 第 2-4 条）

1. 节点管理端「注册与安全」配 SMTP → 客户端指向**节点地址**注册一个测试账号；
2. 节点管理端「用户管理」给测试账号充点积分（或发**本地兑换码**）；
3. 客户端用测试账号跑一次生成。

## 验证

**对账验收标准（唯一硬指标）：跑一次生成后，两侧金额恒等。**

- 节点侧：「请求记录」出现一条 success，用户积分按平台价实扣；
- 源站侧：该商范围的请求记录出现**同一条、金额相同**（管理端「请求记录」范围切到该商；节点转发的记录 ownerId=该商、userId 带 `nu:` 前缀留痕）；
- 对账口径 = 节点「请求记录」合计 vs 源站「渠道商详情 → 请求记录」合计（手册 §4）。

辅助验证：

- 节点管理端可见页 = 用户/兑换码/团队/统计/共享素材/请求记录/注册与安全，模型/渠道/模板/预设/存储等源站专属页自动隐藏、对应 API 403（白名单在 `server\src\auth.ts` 的 `NODE_ALLOWED_ROUTES`）；
- 失败退款两侧同退：任务失败源站自动退池，节点在轮询/每 10 分钟清扫时退本地用户（台账 `relay-ledger.json`，见 `server\src\relay.ts`）。

## 踩坑红线

- ⚠ **重置节点密钥 = 旧密钥立即失效**：**先改节点 `.env` 再重置**，或重置后立刻更新 `.env` 并重启节点（手册 §5；管理端/门户重置按钮的确认弹窗即为此而设，勿去掉确认直接点）。
- ⚠ **relay 模式勿启用 reconcileOnStartup**（`server\src\index.ts` 注释明令）：它会把仍在源站跑的任务当孤儿退款（任务随后完成=用户白拿）；节点的兜底是 relay-ledger 清扫（源站 404 超 72h 按中断退款）。
- ⚠ **计费镜像时序勿改成「先扣本地再转发」**（`server\src\relay.ts` 头注释 + CLAUDE.md §9A 第214轮）：转发前只做本地余额**预检**，真扣按**源站回传实扣**——这是「金额恒等」的唯一依据。
- ⚠ **节点日志落笔定式勿改**（源站侧 `cost:0 + agentCosts:[池实扣] + ownerId:商 + userId:nu: 留痕`）：改了会打断门户/管理端消耗口径与启动对账退款链路。
- 池扣穿 = 所有转发请求 402，终端用户看到中性文案「服务暂不可用，请联系你的服务商」——先查池余额再排障。
- 节点日志出现 `[relay] 本地余额不足实扣` = 节点坏账告警（预估与实扣有差、并发吃穿本地余额），频繁出现让商调高预收积分门槛（手册 §4）。
- 参考视频按秒计费的模型：节点侧预估价不含视频时长加权，**实扣以源站为准**（预检可能偏低，属预期，不是 bug）。
- 节点本地「请求记录」只有 ①请求②响应 两段，上游 ③④ 段只在源站——节点侧排障排不到上游报文属预期。
- 节点暂不支持扩容卡（400 明确提示）；收藏配额=源站全局默认档；团队/共享素材库是节点本地体系，与源站互不相通。
- **源站升级后节点也要同步升级**（同一套代码，协议同步演进）。
- 源站运营侧速查（停用商=节点全部请求 401、看节点消耗、积分分发/扣回）见手册 §6。

## 相关文件

| 用途 | 路径 |
|---|---|
| 权威部署手册（完整流程/对账/边界） | `docs\渠道节点部署手册.md` |
| 角色与源站对接配置（NODE_ROLE / SOURCE_URL / SOURCE_NODE_KEY） | `server\src\config.ts` |
| relay 核心（预检→转发→镜像实扣、relay-ledger 台账、清扫、源站连接自检） | `server\src\relay.ts` |
| 节点密钥生成/重置（`ank-` 前缀，`regenerateAgentNodeKey`） | `server\src\store\agents.ts` |
| 节点凭证端点白名单（`NODE_ALLOWED_ROUTES`，白名单外一律 403） | `server\src\auth.ts` |
| relay 启动分支（启动日志、跳过 reconcile、startRelayLoops） | `server\src\index.ts` |
| 门户自助密钥端点（`/agent-api/node-key` + regenerate） | `server\src\routes\agent.ts` |
| 源站生成密钥 + 节点状态端点（`/admin-api/agents/:id/node-key`、`/admin-api/relay/status`） | `server\src\routes\admin.ts` |
| .env 配置模板（relay 注释段） | `server\.env.example` |
