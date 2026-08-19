---
name: qiji-update-channel-models
description: 更新 Qiji 既有上游渠道的模型清单（上游出新模型/换线/改价/下架时同步到我方）：先按「情报源全表」拉上游最新清单，diff 现状后走 补种/守卫式定向迁移/墓碑 三种改法。当用户说「更新 XX 渠道的模型」「XX 有新模型/模型广场更新了」「看看 XX 上游有什么更新」「同步模型清单」「XX 下架了某模型」时使用。接全新渠道用 qiji-add-upstream-channel。
---

# Qiji 更新渠道模型

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）；下文路径均相对项目根。
> 纯服务端改动——客户端零改动无需打包（模型/家族/方法下拉全走 catalog ≤30s 热更）。
> 接**全新**渠道（要写翻译器、登记 15 个注册点）→ 用 `qiji-add-upstream-channel`；本 skill 只管**既有渠道**的模型增删改。

## 何时使用

- 上游平台上了新模型/新线路，用户要「接上/更新」。
- 上游改价、改档位（时长/分辨率/素材上限）、下架模型。
- 用户问「XX 渠道上游现在有哪些模型」——先按情报源表实拉再回答，不凭记忆。

## 第一步永远是：拉上游最新清单

每个渠道的情报源不同，**全表见 [references/intel-sources.md](references/intel-sources.md)**（22 个渠道逐个带 curl 命令/更新史/坑）。速查：

| 渠道（模式） | 情报源 | 鉴权 | 丰富度 |
|---|---|---|---|
| **congge**（聪宸） | `GET https://congchen.top/api/pricing`（New API 模型广场数据源） | **免鉴权** | 全量：调用ID/元价/时长/素材上限（藏在 description 里） |
| **简梦Z** | `GET https://zexitongxue.com/ai-api/models?type=video`（`type=image` 同理） | **免鉴权** | 全量：时长档/分辨率档/素材上限/note/can_use |
| **Skylee** | `GET https://api.808relay.com/llms.txt` | **免鉴权** | 清单+每模型推荐端点+价目 |
| **算力** | xienlive.com 官方 api.html（内嵌 spec） | **免鉴权**（公开文档页） | 全量 spec；价目靠用户 |
| **即梦 CLI** | bytednsdoc 公网 `version.json`（详见全表） | **免鉴权** | 仅版本号；档位靠升级后 `-h` 实证 |
| **星辰** | `GET {base}/generation/config` | 渠道密钥 | **五渠道最富**：线路×模型×档×价全量 |
| **苏打水** | `GET https://api.sudashuiapi.com/v1/models` | 渠道密钥 | ⚠ 仅模型 id，零能力元数据 |
| **画影** | `GET https://ai-studio.aixyzz.com/v1/models` | 渠道密钥 | mediaLimits 可信；inputModes 不可信 |
| **LibTV CLI** | `libtv model search --type video` + `libtv model <key>` | 本机已登录 | 清单+逐模型全量 schema |
| **Yali** | https://api.yaliai.com/docs（SPA） | 浏览器逐页读 | 全量 spec；无价 |
| 简梦JA/P/M/H/T/F、Dimensio、Aivide、出海营、火山、云雾、autodl | **无自助端点** | — | 等用户提供新版文档（详见全表各条的替代办法） |

⚠ **情报优先级：实时目录 > 文档正文**（第152轮定式：豆包线首尾帧文档说不支持、实时目录 note 明示已支持）。
⚠ New API 系站点（congge/Skylee 同款建站）的展示名与技术 ID 成对出现（「谷歌 Veo 3.1 Fast 快速版」+「veo-3.1-fast」是同一款），diff 前先去重。

## 第二步：与现状 diff

```bash
# 本机 Git Bash：列出该模式现有模型的 上游名 全集（含 routes 重定向真名）
python -c "
import json,io
d=json.load(io.open('server/data/models.json',encoding='utf-8'))
for m in d['models']:
    if m.get('modeId')=='<模式id>':
        rts=[r['upstreamModel'] for r in m.get('routes',[])]
        print(m['id'],'| enabled' if m.get('enabled') else '| DISABLED','->',m.get('upstreamModel'),rts)
"
```

产出三张清单给用户：**新增**（上游有我方无）/ **变化**（价/档/能力变了）/ **下架**（我方有上游无）。价格对比时注意我方是**积分**、上游是**元**——各渠道折算尺见全表（congge≈元/秒×120 按 720p 锚定、Skylee≈元/次×100 等）。

## 第三步：AskUserQuestion 定稿

必问三件（历轮惯例）：**接哪些**（全接/挑选）、**收敛方式**（分辨率编在上游名里的渠道→N 款外显+routes 重定向，还是平铺）、**占位价**（按上游价折算比例，上线前管理端定真价）。命名遵守素材量惯例（933=图9视3音3、903、431…；超三位数如图30 → 名不编码，`cg-sd2.5` 先例）。

## 第四步：改 `server\src\store\models.ts` —— 三种改法，别用错

⚠ **动手前先停本机 dev tsx watch（8787）**——编辑中间态每次保存都被热重启种进真实 dev 库（第216/217轮教训）；全部编辑完、tsc 过后再重启。

| 场景 | 改法 | 机制 |
|---|---|---|
| **新增模型** | 加进 `DEFAULT_MODELS`（用该渠道既有工厂，工厂名见全表） | ③ 补种：启动时只补缺失 id、不动存量。**勿 bump `MODELS_SEED_VERSION`**——bump 会用种子整刷 `MODEL_REFRESH_FIELDS`，冲掉管理端改过的价/参数（第122轮真实事故） |
| **存量能力/档位变化** | 新增 `Store.xxxVersion` 定向迁移字段 + 迁移块 | **守卫式**：只改「仍为旧种子值」的字段——管理端改过价/改过档的分毫不动（第216轮 `xcCaps216Version` 定式；第187轮 `osSd25DurVersion` 实锤用户真价分文未动） |
| **下架** | 定向迁移里把 id 推进 `deletedSeedIds`（墓碑） | 墓碑不复活；翻译器静态能力表（CAPS/LINES）条目按「管理端可能重建」决定去留（第159轮 veo31 留守卫/veo31-ref 删条目两种待遇） |
| **改名/换线** | 删旧 id 进墓碑 + **新 id** 补种 | 绝不复用旧 id；新 id 勿与历史墓碑撞名——撞了补种会被挡（第162轮 `xc933-sd2.0-fast-c` 撞名雷，须先出墓碑再定向补种） |
| **只是加档位**（ID 现拼/参数透传渠道） | **零代码**：管理端给模型参数加档即放行 | 简梦F/简梦H（ID 现拼）、congge 视频（前缀守卫）、火山（clampEnum 实时收敛）皆此类；云雾/autodl 加模型也全在管理端 |

同步检查翻译器的**静态能力表**是否要跟着改（各渠道表位置见全表 notes 列）：星辰 LINES/IMG_LINES、简梦P CAPS、简梦Z CAPS+IMG_CAPS、简梦H FIREFLY_RATIOS+VID_CAPS、Skylee KIND、congge capsOf 前缀…… 新线能力未知时**不守卫直发**（报错优于编造，上游兜底）。

## 第五步：自检 + 收口

与接入轮同一套四件套（详细步骤照抄 `qiji-add-upstream-channel` 的 4–7 节）：

1. `cd server; npx tsc --noEmit`（PS 5.1 分号不是 &&）；
2. 沙盒冒烟（scratchpad 复制 src + junction node_modules + 独立 data + stub fetch）——**更新轮必须多测一组「真实库副本迁移」**：复制真实 `data/*.json` 进沙盒跑迁移，断言 迁移生效 + **存量条目零改动**（逐条 diff）+ 管理端改过价的字段分毫未动；⚠ 全新空库首启走快速初始化**不进迁移段**——只测全新库等于没测迁移；
3. 二启幂等（data 文件 md5 零变化）；
4. CLAUDE.md §8 记轮次（标注「须重新部署服务端；占位价上线前定真价」）+ 部署（`qiji-pack-and-deploy-server`）。

## 踩坑红线

1. ⚠ **勿 bump `MODELS_SEED_VERSION`**（整刷冲管理端改动）——新模型走补种、存量变化走守卫式定向迁移，没有第三条路。
2. ⚠ **上游模型名逐字照抄**：congge 带空格且大小写敏感（`seedance2.0 Mini-480p`）、Skylee 的 `[zz] ` 后有空格、星辰 `channel|model|quality` 三段编码——改一个字符即模型不存在。congge 广场 2026-08-17 实拉还出现同系不同款空格不一致（`903 Fast-480p` 有空格、`903Fast-720p` 无空格）——**每一条都单独照抄，勿按同系规律推**。
3. ⚠ **墓碑不复活、id 不复用**：恢复旧模型用新 id；新 id 先 grep `deletedSeedIds` 防撞名。
4. ⚠ **参数档只在 models.ts 参数定义把关**，翻译器一律 paramPass 原样透传——更新时发现旧翻译器有夹钳残留（过时注释也算）顺手清，勿新增（第186/187/215轮亏钱事故）。
5. ⚠ **价格 diff 别只看数字**：上游是元、我方是积分，各渠道折算尺不同（见全表）；同款模型跨渠道差价可达 7 倍（congge vs Skylee 的 gpt-image-2）——更新价时提醒用户横向核一遍，别定反。
6. ⚠ **模式/渠道条目不动**：更新轮只动 models.ts（+翻译器能力表），`MODES_SEED_VERSION`/channels 种子是接入轮的事；真要改模式名让用户在管理端「模式管理」点。
7. ⚠ **实拉要留档**：把上游清单原始响应存 scratchpad 并把关键结论写进 CLAUDE.md 轮次记录（后续更新轮要对比「上次实拉」）。

## 后续接新渠道时如何操作（接入轮的配套义务）

接入新渠道（走 `qiji-add-upstream-channel`）时**必须顺手做三件事**，否则日后更新只能干等用户转发文档：

1. **主动找自助情报端点**——别等文档给：
   - New API 系建站（后台是 `/console`、接口 OpenAI 形）：依次试 `GET /api/pricing`（公开模型广场数据源，congge 实锤）、`GET /llms.txt`（Skylee 实锤）、`GET /v1/models`（Bearer）；
   - 自研站：试 `/ai-api/models`（简梦Z 式）、`/generation/config`（星辰式）、`/v1/models`；官方文档页看有没有内嵌 spec（算力式）；
   - 全都没有 → 在翻译器头注释明写「无自助端点，更新靠用户提供文档」。
2. **把情报源写进翻译器头注释**（含完整 URL/命令与鉴权要求）——头注释是更新轮的第一情报位。
3. **在本 skill 的 [references/intel-sources.md](references/intel-sources.md) 增补一行**（渠道/端点/鉴权/丰富度/工厂名/坑）——表是活的，接一个补一个。

## 相关文件

| 用途 | 路径 |
|---|---|
| **情报源全表（22 渠道逐个：curl/更新史/坑）** | 本 skill `references\intel-sources.md` |
| 模型种子/工厂/迁移版本字段/墓碑 | `server\src\store\models.ts` |
| 参数透传 helper（禁止夹钳） | `server\src\translators\paramPass.ts` |
| 各渠道翻译器（头注释=第一情报位） | `server\src\translators\*.ts` |
| 接全新渠道（翻译器+15 注册点） | skill `qiji-add-upstream-channel` |
| 本地 CLI 渠道升级（LibTV/即梦） | skill `qiji-local-cli-upgrade` |
| 定真价/调价 | skill `qiji-model-pricing-ops` |
| 打包部署 | skill `qiji-pack-and-deploy-server` |
