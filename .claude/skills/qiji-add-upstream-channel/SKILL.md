---
name: qiji-add-upstream-channel
description: 为 Qiji 服务端接入新上游渠道（视频/图片生成渠道）：写翻译器 + 15 个注册点逐点登记 + 沙盒冒烟 + 二启幂等验证。当用户说「接新渠道」「新增上游渠道」「接入 XX 平台/渠道」「加新模式」「新增渠道模型」时使用。
---

# Qiji 接入新上游渠道

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）；下文路径均相对项目根。
> 本 skill 覆盖纯服务端接入——客户端零改动无需打包（模式/家族/模型下拉全走 catalog ≤30s 热更）。

## 何时使用

- 用户提供某上游平台的 API 文档，要求「接入新渠道 / 新增模式 XX / 把 XX 的模型接上」。
- 给既有渠道补新模型/新线路时可参照本流程（只走「模型种子补种 + 定向迁移」，不建新协议）。
- 历史已做 20+ 次（简梦 JA/P/M/Z/H/T/F/S、星辰、画影、Dimensio、Aivide、苏打水、出海营、算力、Yali、Skylee、congge、autodl…），每次要改 11–15 个注册点，**漏任何一个都是「模型建了但派发不到 / 协议下拉里没有 / 品牌词泄漏给用户」**，排查成本以小时计。

## 前置检查

1. 读上游文档，确认四件事（写进翻译器头注释）：
   - **鉴权形态**：Bearer sk- / 原样 Token 不带 Bearer（autodl）/ `apikey` 头（简梦M）；
   - **提交与查询端点**及回执形状：同步单请求 / 异步 submit+poll / SSE 流式；
   - **素材字段与引用语法**：`@ImageN` 直通（简梦T）/ `<<<N>>>` 0 基下标（算力）/ `ref_image_0..N`（autodl）；
   - **状态词枚举**是否公布齐全（未公布失败词 → 必须防御式状态族）。
2. 参考素材（均已核实存在）：
   - 翻译器模板：`server\src\translators\autodl.ts`（最新、最完整）、`suanli.ts`、`congge.ts`（图片+视频双协议）；
   - 协议格式：`资料\anthropic格式.md`、`资料\gemini格式.md`、`资料\openai格式接口.md`、`资料\简梦JA渠道对接(1).md`、`资料\插件编写标准.md`。
3. ⚠ **动 modes/models/channels 种子代码前先停本机 dev tsx watch（8787）**——编辑中间态每次保存都会被热重启种进真实 dev 库（第216/217轮教训）；全部编辑完、tsc 过后再重启。
4. ⚠ 绝不整读 `CLAUDE.md`（502KB 会撑爆上下文）——查历轮规则用 Grep 带 head_limit 精准搜 §9A 关键词。

## 步骤

### 1. 写翻译器 `server\src\translators\<新名>.ts`

抄 `autodl.ts`（异步 submit+poll）或 `congge.ts`（同步图片 + 异步视频）：
- **submit**：前置守卫（未配密钥 / workflow·模型未配置 / 素材超上限 / 不支持的素材类型 / 空提示词）→ 一律**明确报错、不发请求、不扣费**；
- **poll**：状态族防御——SUCCESS/FAILED/QUEUED 三个 Set，**未公布的状态词一律不终态**（返回 running 继续轮询，任务有 2h 总超时兜底）；5xx/429/网络抖动返回 running；成功但无成片链接=明确失败；
- **参数**：时长/比例/分辨率一律经 `server\src\translators\paramPass.ts` 的 `numberParam`/`stringParam` 原样透传，缺省才补默认；
- **结果下载鉴权**：只对本站域（结果域 == 渠道 baseUrl 域）附 Authorization，密钥绝不外发第三方 CDN。

### 2. 按注册点全表逐点登记

15 个注册点全表（含已核实行号与 autodl 实例位置）见 [references/registration-points.md](references/registration-points.md)。
**最容易漏的五个**（症状对照）：

| 注册点 | 漏掉的症状 |
|---|---|
| `server\src\translators\index.ts:491` 附近 dispatch case | 模型建了但派发不到 |
| `server\src\admin\index.html:1013` `PROTOCOLS` 数组 | 管理端模型编辑器协议下拉里没有 |
| `server\src\errorScrub.ts:20` BRAND_TOKENS + :109 域名清单 | 上游品牌词/域名泄漏给用户 |
| `server\src\routes.ts:233` `REHOST_ALLOW_SUFFIXES` | 成片转存 OSS 失败、只剩时效直链 |
| `server\src\translators\index.ts:154` BUILTIN_POLL_INTERVALS | 轮询间隔停在缺省 8s（上游要求更快/更慢时才需加） |

### 3. 定价

新模型全部用**占位价**（按上游 元/秒 或 元/次 比例折算），并在 CLAUDE.md 本轮记录标明「上线前管理端定真价」；按秒计费的兜底价 = 每秒价 × 该模型最长时长（「默认按最高」，第134轮规则）。

### 4. 本机自检

```powershell
# 本机 PowerShell 5.1（不支持 &&，用分号或分行）
cd server; npx tsc --noEmit; cd ..
```

改了 `server\src\admin\index.html`（PROTOCOLS 下拉）必须做 script 语法校验（tsc 抓不到，漏了=控制台整页白屏）：

```bash
# 本机 Git Bash（按 UTF-8 读；PS 默认编码会把中文读坏产生假语法错——第147轮）
node -e 'const h=require("fs").readFileSync("server/src/admin/index.html","utf8");const m=[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];m.forEach(x=>new Function(x[1]));console.log("admin script OK:",m.length)'
```

### 5. 沙盒冒烟（零真实上游调用、零真实库触碰）

历轮固定做法：scratchpad 复制 `server\src`（+`server\skills`）+ **junction**（不是复制）`server\node_modules` + 独立 data（`server\src\config.ts` 的 DATA_DIR 按模块相对路径推导 → 沙盒天然独立 data）+ stub 全局 fetch。

```powershell
# 本机 PowerShell 5.1
$SB = "$env:TEMP\qiji-sbx"; New-Item -ItemType Directory -Force $SB | Out-Null
Copy-Item server\src "$SB\src" -Recurse -Force
Copy-Item server\skills "$SB\skills" -Recurse -Force
cmd /c mklink /J "$SB\node_modules" (Resolve-Path server\node_modules).Path
```

冒烟断言至少覆盖五组（对照 autodl 轮 54/54 的分组）：
1. **种子入库**：模式 / 渠道 / 模型（协议、素材上限、参数档、计费、家族归类、resolveUpstream）；
2. **catalog 下发**：模型在列、**不泄漏上游真名**（routes 重定向款）与内部线路标记；
3. **submit**：URL 与 body 形状、鉴权头形态、@tag 图例注入、参数透传（含越档值原样透传的正例）、各前置守卫的负例（超限/缺配置/空提示词含 `"{}"` 兜底形态/错误素材类型）；
4. **poll**：各状态族（未知词不终态、5xx/429 running、失败透出上游 message、成功无链接明确失败、第三方 CDN 不附鉴权头）；
5. **errorScrub**：品牌词/域名被擦、模式名经占位符保护保留。

### 6. 二次启动幂等

沙盒内第二次启动前后比对 data 文件哈希，**须零变化**：

```powershell
# 本机 PowerShell 5.1（二启前后各跑一次，逐行比对 Hash）
Get-FileHash "$SB\data\*.json" -Algorithm MD5 | Format-Table Hash, Path
```

### 7. 收口与部署

- 记 CLAUDE.md §8 本轮条目 + 头部「最后更新」（并行会话注意撞号），标注「**须重新部署服务端；部署后到管理端 XX 渠道填密钥**（或环境 `XXX_API_KEY`）」；客户端零改动无需打包。
- **登记模型更新情报源**（`qiji-update-channel-models` 的配套义务，漏了日后更新只能干等用户转发文档）：①主动探自助清单端点——New API 系站（后台 `/console`）依次试 `GET /api/pricing`（公开模型广场数据源）、`GET /llms.txt`、`GET /v1/models`（Bearer）；自研站试 `/ai-api/models`、`/generation/config`；②把情报源（完整 URL/命令+鉴权要求）写进翻译器头注释；③在 `qiji-update-channel-models\references\intel-sources.md` 按「有/无自助端点」增补一行。
- 打包部署走 `server\scripts\pack-deploy.ps1` 流程（详见 qiji-pack-and-deploy-server），服务器侧：

```bash
# 服务器 Linux bash（1Panel 上传 qiji-server-deploy.tgz 到 /root 后）
tar xzf qiji-server-deploy.tgz -C /opt/qiji
cd /opt/qiji && docker compose up -d --build
```

## 验证

1. 本机四件套全绿：server tsc 干净 + admin script 语法过 + 沙盒冒烟全过 + 二启幂等（data 文件 md5 零变化）。
2. 部署后用本轮独有字符串实锤新代码上线：

```bash
# 服务器 Linux bash（应输出 ≥1；0 = 上传的是旧包）
grep -c "<本轮独有函数名或字符串>" /opt/qiji/server/src/translators/<新名>.ts
```

3. 管理端：新渠道填密钥（种子 apiKey 为空，不填则提交明确报「未配置上游密钥」）→ 新模式/模型出现在管理端与客户端下拉（≤30s）→ **小额真单**全链路（提交→轮询→成片转存 OSS）→ 请求记录 ③④ 段核对实发 body 与上游回执 → 据 ④ 段成片实际托管域，回补 `REHOST_ALLOW_SUFFIXES`。

## 踩坑红线

1. ⚠ **`server\src\store\modes.ts:58` 的 `MODES_SEED_VERSION`：版本号与条目必须一次编辑**——分两次保存会被 tsx watch 热重启竞态吃掉条目（第151/186轮两次踩过；先停 watch 是双保险）。
2. ⚠ **家族归类新规则须排在 seedance 数字兜底正则之前**——`classifyFamily` 在 `server\src\store\models.ts:1095`（不在 families.ts，families.ts 只是家族注册表本体），minimax/happyhorse 类规则若排在 `/933|900|903/` 之后，带数字段的模型 id 会被误吞进 fam-seedance（第216轮沙盒实锤）。
3. ⚠ **参数透传必须用 `paramPass.ts`，禁止任何夹钳/就近取档/白名单回退**——静默改小参数却按请求参数扣费 = 多扣钱少交货（第186/187/215轮真实亏钱事故）。
4. ⚠ **未公布的状态词一律不终态**——文档没写失败状态词时，未知词返回 running 继续轮询，绝不猜终态（任务 2h 总超时兜底）。
5. ⚠ **定价先用占位价**并在 CLAUDE.md 标明「上线前定真价」——ComfyUI 类按 GPU 时长计费的渠道务必先小额真单对账再定真价。
6. ⚠ **必须跑二次启动幂等**（data 文件 md5 零变化）——补种/迁移写坏会在每次重启重复执行。
7. ⚠ **收口必须记 CLAUDE.md §8** 并标注「须重新部署服务端 + 部署后到管理端填密钥」。
8. ⚠ **上游模型名逐字照抄**——congge 的模型名带空格且大小写敏感（`seedance2.0 Mini-480p`），改一个字符即模型不存在（第233轮）；勿「顺手规范化」。
9. ⚠ **errorScrub 的「域名隐藏」已固定在「模式名占位符保护」之前**（`server\src\errorScrub.ts:138` 注释）——模式名是上游域名子串时（autodl / autodl.art），顺序反了裸域名会逃逸（第234轮修的真缺陷）；新渠道冒烟必须验「域名被擦 + 模式名保留」。
10. ⚠ **结果下载鉴权头只对本站域附 Authorization**（第153轮规则）——密钥绝不外发第三方 CDN。
11. ⚠ **素材超上限/不支持的素材类型 = 前置明确报错，绝不静默丢**——丢一张图 = @ImageN 图例整段错位（第118轮「一张都不许静默丢」）。
12. ⚠ **补种机制勿 bump `MODELS_SEED_VERSION` / 模板 `SEED_VERSION`**——新模型走补种（只加缺失、不动存量），墓碑（`deletedSeedIds`）里的旧 id 不复活、不复用（恢复旧模型要用新 id，第216轮）。

## 相关文件

| 用途 | 路径 |
|---|---|
| 注册点全表（15 点带行号） | 本 skill `references\registration-points.md` |
| 既有渠道更新模型（情报源全表） | skill `qiji-update-channel-models` |
| 翻译器模板（最新最完整） | `server\src\translators\autodl.ts`（另参 `suanli.ts`、`congge.ts`） |
| 参数透传 helper（必须用） | `server\src\translators\paramPass.ts` |
| 协议派发 / 驱动表 / 轮询间隔 | `server\src\translators\index.ts` |
| 上游解析回退 + 环境配置段 | `server\src\translators\upstream.ts`、`server\src\config.ts` |
| 内置协议清单 | `server\src\store\protocols.ts` |
| Protocol 联合 / 模型种子 / 家族归类 / 墓碑 | `server\src\store\models.ts` |
| 模式注册表 | `server\src\store\modes.ts` |
| 渠道种子 | `server\src\store\channels.ts` |
| 品牌词/域名擦除 | `server\src\errorScrub.ts` |
| 成片转存白名单 | `server\src\routes.ts` |
| 管理端协议下拉 | `server\src\admin\index.html` |
| 环境变量样例 | `server\.env.example` |
| 上游协议格式参考 | `资料\anthropic格式.md`、`资料\gemini格式.md`、`资料\openai格式接口.md`、`资料\简梦JA渠道对接(1).md`、`资料\插件编写标准.md` |
