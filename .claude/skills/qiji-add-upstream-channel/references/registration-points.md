# 接入新上游渠道 · 注册点全表（15 点）

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）；路径均相对项目根。
> 行号于 2026-08-16（第234轮，autodl 接入后）逐一用 Grep 核实；后续轮次会漂移，**改前先按「定位符号」列重新 Grep 确认**。
> 「autodl 实例」列 = 第234轮 autodl 接入在该注册点留下的真实位置，抄作业直接看它。

| # | 用途 | 路径 | 定位符号 | 行号参考 / autodl 实例 |
|---|---|---|---|---|
| 1 | 新翻译器（submit + poll + 守卫） | `server\src\translators\<新名>.ts` | — | 模板：`autodl.ts`（全文 179 行，最新最完整）；同步图片参 `congge.ts`、`<<<N>>>` 引用参 `suanli.ts` |
| 2 | Protocol 联合类型加新协议 id | `server\src\store\models.ts` | `export type Protocol` | :14 |
| 3 | 内置协议清单加 id | `server\src\store\protocols.ts` | `BUILTIN_PROTOCOLS` | :16-20（id 加进 :19 的数组；`autodl-video` 已在列） |
| 4 | 视频驱动表 + 轮询间隔 | `server\src\translators\index.ts` | `VIDEO_DRIVERS` / `BUILTIN_POLL_INTERVALS` | :124 驱动表（autodl 条目 :146-147）；:154 间隔表（缺省 8s，仅非缺省协议加条目，如 jmt/jmf/congge 5s、aivide 12s）。同步单请求协议（jmh/yali 类）**不进**驱动表 |
| 5 | dispatch 分派 case | `server\src\translators\index.ts` | `case "<协议id>"` | :491（`case "autodl-video"`）；视频=`createVideoPollingTask(..., "video", {intervalMs})` :492-493、异步图片=同函数带 `"image"` :499、同步图片=`createImageTask` |
| 6 | 上游解析回退（协议 → config 段） | `server\src\translators\upstream.ts` + `server\src\config.ts` | `m.protocol === "<协议id>"` / `config.<新名>` | upstream.ts :67-68（autodl 分支）；config.ts :186-192（autodl 段：`AUTODL_BASE_URL`/`AUTODL_API_KEY`，新渠道同构加 `XXX_BASE_URL`/`XXX_API_KEY`） |
| 7 | 模式注册表（⚠ 版本号与条目一次编辑） | `server\src\store\modes.ts` | `MODES_SEED_VERSION` | :58（当前 =21，autodl 轮 bump 至此）；版本闸 :83-101 |
| 8 | 渠道种子 | `server\src\store\channels.ts` | `CH_<新名大写>` | :56 常量（`CH_AUTODL`）；:162-166 种子条目（baseUrl 填根域、apiKey 留空由管理端填） |
| 9 | 模型种子（工厂 + 补种）/ 墓碑 | `server\src\store\models.ts` | 工厂函数名 / `deletedSeedIds` | autodl 工厂 :792-797（`adlParams`/`adl`）、种子条目 :1076-1079；墓碑字段 :143；⚠ 新模型走**补种**（只加缺失），勿 bump `MODELS_SEED_VERSION`；墓碑里的旧 id 不复活不复用 |
| 10 | 家族归类（⚠ 新规则排在 seedance 数字兜底之前） | `server\src\store\models.ts`（⚠ 不在 families.ts） | `classifyFamily` | :1095；`/933\|900\|903/` 类数字兜底在函数尾部，minimax/happyhorse 类词规则必须排它之前；`server\src\store\families.ts` 只是家族注册表本体（其 :13 注释亦指回 models.ts） |
| 11 | 品牌词/域名擦除 | `server\src\errorScrub.ts` | `BRAND_TOKENS` | :20 品牌词清单（autodl 词 :66-68）；:109 域名清单（`autodl.art`）；:138 附近注释=「域名隐藏在模式名占位符保护**之前**」的顺序红线（第234轮） |
| 12 | 成片转存白名单 | `server\src\routes.ts` | `REHOST_ALLOW_SUFFIXES` | :233 起数组；成片实际托管域未知时先放行 API 根域，真单转存失败后看请求记录 ④ 段回补（数组内注释即此惯例） |
| 13 | 管理端协议下拉 | `server\src\admin\index.html` | `const PROTOCOLS` | :1013（改完必须做 script 语法校验——见 SKILL.md 步骤 4） |
| 14 | 环境变量样例 | `server\.env.example` | `<新名大写>_BASE_URL` | autodl 段 :103-108（注明鉴权形态与 Base URL 拼法惯例） |
| 15 | 参数透传 helper（⚠ 必须用） | `server\src\translators\paramPass.ts` | `numberParam` / `stringParam` | 全文 18 行；显式值原样透传、缺省才补默认；禁止任何 夹钳/就近取档/白名单回退 |

## 行号快速复核命令

```bash
# 本机 Git Bash（行号漂移时一把梭重新定位）
grep -n "export type Protocol" server/src/store/models.ts
grep -n "BUILTIN_PROTOCOLS" server/src/store/protocols.ts
grep -n "VIDEO_DRIVERS\|BUILTIN_POLL_INTERVALS" server/src/translators/index.ts | head -5
grep -n "MODES_SEED_VERSION" server/src/store/modes.ts | head -2
grep -n "classifyFamily" server/src/store/models.ts | head -3
grep -n "BRAND_TOKENS" server/src/errorScrub.ts | head -2
grep -n "REHOST_ALLOW_SUFFIXES" server/src/routes.ts | head -2
grep -n "const PROTOCOLS" server/src/admin/index.html
```

## 翻译器编写要点速查（以 autodl.ts 为准）

- **鉴权三形态**：Bearer sk-（多数）/ 原样 Token 不带 Bearer（autodl，文档明写 `{"Authorization": 您的Token令牌}`）/ `apikey: MUSE-...` 头（简梦M）——勿照抄别家。
- **状态族三个 Set**（autodl.ts :60-62）：`SUCCESS_STATES` / `FAILED_STATES` / `QUEUED_STATES`；未知词 → running；信封形态（`{msg,code,data}`）与扁平形态双收（`unwrap` :56-58）。
- **提交安全闸**：submit 用 `submitSignal()`（`server\src\translators\submitTimeout.ts`，缺省 30 分钟安全闸，第169轮取消短超时——提交慢 ≠ 失败）；poll 用 `AbortSignal.timeout(30000)` 短超时 + 抖动返回 running。
- **图例注入**：`resolveNamed` + `injectReferenceTags`（从 `jianmeng.ts` 导入）；带故事板整体参考图**追加素材末尾**并加提示词说明行（前插=编号错位）。
- **空提示词拦截**：含 `buildPrompt` 无输入时的 `"{}"` 变量兜底形态也视为空（autodl.ts :122）。
- **onUpstream 报文**：提交 request 里的密钥经 `maskToken` 脱敏后才进日志 ③ 段。

## 沙盒冒烟断言分组（autodl 轮 54/54 的构成，供起卷子参考）

1. 种子 12：模式/渠道/3 模型（协议、素材上限、分辨率档差异、计费、家族、占位符、resolveUpstream）；
2. 提交 22：守卫负例（未配密钥/未配 workflow/超限/错误素材类型/空提示词）+ URL 与 body 形状 + 鉴权头形态 + 参数透传正例（越档 20s 原样发）+ 图例注入 + 上游错误体透传；
3. 轮询 15：三态 + 未知词不终态 + 5xx/429/网络抖动 running + 404 failed + 成功取片/封面 + 第三方 CDN 不附头/本站域附头 + 信封形态；
4. errorScrub 4 + 既有渠道回归 3；
5. 二启幂等：全部 data/*.json 哈希零变化。
