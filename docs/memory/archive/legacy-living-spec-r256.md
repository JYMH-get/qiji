# Qiji 漫剧创作平台 · 需求规格文档（Living Spec）

> 本文档是用户端与管理端开发的**唯一事实来源**。每轮沟通后更新。
> 状态标记：✅已锁定　🟡讨论中　⬜待定
> 历轮完整细节见 git 历史中的旧版 CLAUDE.md（第80轮起只保留结论，不保留过程叙述）。

最后更新：2026-08-28（第256轮：**客户端素材图例增量合并 + .Qiji 本地资产缺失自愈·纯客户端**——①素材图例从「整块剥离/重建」升级为按 @tag 逐资产解析与合并：匹配素材、外部拖入、本地导入只补缺失说明，保留用户改过的「@ImageN 是 xxx」与提示词正文；兼容空行、单换行、同行三种边界，删除/重排继续正确移除和重编号。②新增 [projectAssetHeal.ts](src/services/projectAssetHeal.ts)：加载/导入项目及显示时先校验 `localPath`，缺失则用三元映射 OSS url、必要时凭 id 取新链，以**同一台账 id**下载本地副本并改写旧引用；含三路并发、同项目防重、跨项目串写护栏。③画布投影前插故事板图属于资产身份换位，显式全量重建图例，避免错误继承旧编号说明。client tsc 干净 + **1352 vitest 全过（1341→1352，+11）** + vite build 过。**须客户端重新打包；服务端零改动无需部署**。待真机 QA：导入不带 assets/、但 assetBlobs 含有效 OSS 链接的 .Qiji，确认资产页/分镜/画布逐步恢复；运行中删本地副本后重新打开显示点确认懒恢复。详见 §8。）

上一轮：2026-08-22（第255轮：**QiQi（pidoi.com）视频渠道接入 · **2 模型 / 同站两套请求形态** / 新模式「QiQi」·纯服务端 · server tsc 干净 + admin script 语法过 + 沙盒冒烟 **142/142**（全新库；stub fetch 零真实上游、真实库零触碰）+ 二启幂等（2→3 启 data md5 零变化）+ **部署路径 15/15**（真实 dev 库副本还原成部署前形状后一次跑完 158→160 模型 / 23→24 模式 / 28→29 渠道，**存量条目逐条 deep-equal 零改动**）+ dev 8787 热迁移实锤 · 客户端零改动无需打包**——用户提供官方《Seedance 视频生成 API 调用文档》令「增加渠道 QiQi」。①**上游（Base `https://pidoi.com`，Bearer sk-，New API 系网关）**（新 [qiqi.ts](server/src/translators/qiqi.ts)，协议 `qiqi-video`，异步 submit+poll）：提交 `POST /v1/videos` → `{id:"task_xxx",status:"queued"}`；查询 `GET /v1/videos/{task_id}` → queued / in_progress(progress) / completed(video_url) / failed(error{code,message})；文档建议 3~5 秒轮询 → 间隔取 **4s**。②**content[] 多模态形态**：`{model, prompt, content[], seconds, ratio, generate_audio?}`——content 项 `{type:"image_url"|"audio_url"|"video_url", role, <同名对象>:{url}}`，⚠ **无 name 字段**（编号由各类素材在 content 中的出现顺序决定，逐字照文档、勿照抄出海营的 name）；⚠ **顶层 prompt 与 content[0].text 必须同文**（文档 §17.1 明列的常见错误）。③⚠ **素材引用是小写 `@image1/@audio1/@video1`**（三类分别编号）→ 新 `qiqiLowerTags` 把 injectReferenceTags 的 @ImageN 统一转小写（简梦P h3/苏打水同先例）。④**守卫（一律明确报错、不发请求、不扣费）**：图9/音3/视3 上限、空提示词（含 `"{}"` 兜底形态）、首尾帧恰两图且拒视频音频，⚠ **用音频/视频参考时必须至少 1 张图**（文档 §5.4/§17.2：图片是人物/场景锚点，纯音频/纯视频参考会失败）——前置拒单别让用户白等一次失败。⑤**参数（§9 原样透传）**：duration → 上游 **`seconds` 字符串**（客户端参数键仍 duration、计费恒走 costField=duration）、⚠ 缺省补 15 而非文档默认 "4"（与兜底价「每秒价×最长时长」严格对齐，避免按最长扣费却按 4 秒出片）；ratio 缺省 16:9；generate_audio 显式才发；⚠ **resolution 一律不发**（分辨率编在模型名后缀里，文档 §2/§17.4 明示传了会与模型档位冲突拒单——congge 视频侧同规）。⑥**第二形态 flat（同站第二份文档《视频生成接口说明·933真人视频》2026-07-26，模型 `sora-v3-933-pro`）**：同端点同鉴权但**字段族完全不同**——扁平 `image_url`(主参考图) + `reference_image_urls`/`reference_videos`/`audio_urls`（只发一套主字段，别名一概不用）、**`resolution` 必填 720p**（与 content 形态「一律不发」正相反）、`seconds` 仅 15、**不支持尾帧图**、**单次素材总数 ≤12**（跨类闸）；音频参考「建议带图」是软措辞→不拦（区别于 content 形态的硬约束）。⚠ **两形态的素材引用语法相同**（小写 @imageN，用户实锤；7.26 文档正文未写但底层同源）→ 都注入图例，flat 的编号顺序 image_url(第1张)→reference_image_urls[…] 天然对齐。翻译器 `shapeOf(upstreamModel)` 分派（显式表 + 未知名按 /sora|933/ 兜底走 flat、其余 content）。⑦**2 模型**：`qq933-sd2.0-720p`「QiQi·Seedance 2.0 720p」（⚠ **上游名逐字 `seedace-2.0-720p`，文档全篇少一个 n、不是 seedance——勿"顺手纠正"**；methods omni+frames；占位价 **50 积分/秒**、兜底 750） + `qq933-sora-v3-pro`「QiQi·Sora V3 933 真人 720p」（上游 `sora-v3-933-pro`；时长仅 15 一档、**不声明 methods**（无尾帧）、无 generate_audio 参数；占位价 **60 积分/秒**、固定单价 900）；两款素材上限均 933、家族均自动归 fam-seedance（`sora-v3` 命中既有「全能参考 sora=Seedance 换壳」规则）；两款都**不设 resolution 参数**（各自只有 720p 一档）。⑧注册面 15 点全登记（Protocol 联合/BUILTIN_PROTOCOLS/VIDEO_DRIVERS/轮询间隔/dispatch case/upstream fallback+config.qiqi（`QIQI_BASE_URL`/`QIQI_API_KEY`）/modes v24（版本号与条目一次编辑）/渠道 ch-qiqi/模型工厂+种子/errorScrub 品牌词 QiQi·pidoi + 域名 pidoi.com/REHOST 白名单/admin 协议下拉/.env.example）。⚠ **须重新部署服务端**（首启自动补种 模式 v24+渠道+模型；**部署后到管理端「QiQi（pidoi）」渠道填 sk- 密钥**，或环境 `QIQI_API_KEY`——不填提交明确报「未配置上游密钥」）；**客户端零改动无需打包**（模式/家族/模型下拉全走 catalog 热更 ≤30s）。**运营注意**：①**两款均为占位价**（50 / 60 积分每秒，按同类 720p 线 元价×100 折算尺估），上线前管理端定真价——⚠ 该站**价格无免鉴权来源**（`/api/pricing` 需登录态，文档只说「以模型广场实时展示为准」），须登录站点看模型广场或小额真单对账；②两份文档各自都写「当前仅支持」自家那一款——**可能是两条并行产品线，也可能其一已下线**，建议部署后用密钥拉一次 `GET /v1/models`（Bearer）核实两款是否都在线，不在线的在管理端停用即可；③站内其余款=管理端在 ch-qiqi 新建零代码（协议 qiqi-video、上游名照抄清单**逐字勿改**）——⚠ 新款走哪套形态由翻译器按名分派（sora/933 系→flat，其余→content），形态不对会被上游 400 拒单；④Seedance 款**能垫视频/音频但必须同时带至少 1 张图**；933 真人款固定 15 秒、不支持尾帧、素材总数 ≤12。**待真机 QA**：两款各跑小额真单（Seedance 款：纯文生 / 多图+音视频全能参考 / 首尾帧；933 真人款：多图+音视频全能参考）、小写 @imageN 被上游正确识别、成片 `video_url` 转存 OSS（若失败看请求记录 ④ 段实际托管域回补 `REHOST_ALLOW_SUFFIXES`）。详见 §8。）
## 进度快照（新会话先读这里）

> 🚧 **进行中的大改（2026-07-30 起）**：存储与数据结构改造（OSS 分层+保留策略+配额 / 服务端热路径迁 SQLite / 客户端项目文件换 SQLite）。
> **完整方案见 [docs/存储与数据结构改造方案.md](docs/存储与数据结构改造方案.md)** —— 该文档是这项改造的唯一事实来源，含实测数据、表结构、分阶段计划（P0–P5）。

**架构**：用户端(Tauri/React, 项目根) → 管理端网关(`server/`, Fastify+TS) → 上游（g-aisc 聚合网关 `https://sub.g-aisc.com`，一把 sk- + Bearer，兼容 OpenAI/Anthropic/Gemini 三协议；视频另有 简梦/喵-Mega 独立渠道）。

**当前状态（主链路全通）**
- 用户端：登录+30s 心跳（掉线容差：401/403 立即登出，瞬时失败连续 10 次≈5 分钟才登出）→ catalog 热更 → 剧本编辑（剧集拆分/资产拆分，流式）→ 五类资产出图（角色/群像/场景/生物/物品，变体图生图）→ 视频界面（智能推理/拆分出分镜+故事板提示词+视频提示词，垫素材自动匹配，故事板图、视频生成，导出）→ 画布模式（9 类节点、裂变、每分集独立画布、手动投影仅剧集/分镜——资产不投影防卡）。
- 管理端 `/admin`（ADMIN_TOKEN，自包含单页）：用户（增删改查/启停/重置 API 密钥/统计图表可导出；获客走自助注册+邀请码，P2b 起无激活码）、渠道、模型（协议/重定向/参数/计费）、提示词模板、兑换码、注册与安全、OSS 存储、请求记录（四段全留+筛选）。
- 积分闭环：按字段计费（视频按秒 `costField×costPerUnit`，路由按档覆盖）、`/generate`+`/batch` 前置校验（402）、异步失败自动退款、兑换码（`/v1/redeem`）、个人中心（`/v1/me`）。
- 项目文件安全：**原子保存 + `.bak` 滚动备份 + 损坏自动恢复/明确报错**（第79轮）。

**质量**（2026-07-07 实测）：client `tsc --noEmit` 干净 + **180 vitest 全过（24 文件）** + `vite build` 过；server `tsc --noEmit` 干净（2026-07-03）。

**⚠ 版本控制现状**：最新 commit `082e4bf`；工作区仍有 **~268 项未提交**（第49轮起的客户端功能迭代 + 第70轮死文件清理 + server 增量）。**建议尽快分阶段提交固化**。

**运行**：`cd server && npm i && cp .env.example .env`（设 ADMIN_TOKEN、GATEWAY_API_KEY）→ `npm run dev`（/admin 默认 admin-dev）；项目根 `npm run dev`（登录填 http://localhost:8787 + accessKey 首启默认 dev-key）。server 跑 `tsx watch`，改 .ts 自动重启。

**待办/已知问题**（详见 §7）：genMeta 落盘 base64 撑爆项目文件（161MB 事故根源，已立修复任务）；Postgres/批量拓扑未做（任务表已 JSON 落盘+启动对账，第89轮）；客户端需重新打包（第79轮 capabilities 变更）；**服务端需重新部署**（第89轮启动对账须上线生效，首启会清扫存量僵尸日志并按日志退款）。

---

## 0. 合作方式 ✅

- 中文沟通。
- **先把需求/协议/格式完全确定，再一次性开发**（用户端 + 管理端同时做）。
- 本文档代替"长期记忆"（用户未开启 Claude 记忆功能），作为跨轮次的共识载体。
- 用户邀请：知识面有限，遇到更好的方案请主动提出建议。
执行任务时，不要只按字面要求生成结果
请同步运用以下四象限：

1. 共同已知：先确认任务目标、已有背景、交付标准和明确边界。信息充分时直接执行，不要重复询问。

2. 我的已知、你的未知：识别可能只存在于我脑中的真实语境、审美偏好、判断标准和现实限制。若缺失信息会显著改变结果，最多提出3个关键问题；若不影响推进，则明确你的合理假设，先完成探索版本。

3. 我的未知、你的已知：主动补充我可能没考虑到的知识、方法、风险和替代路径。不要局限于我的原始方案；如果我的前提可能错误，请直接指出，并给出更优建议及取舍依据。

4. 共同未知：识别无法仅靠现有信息确定的问题，把它们转化为可验证的假设，必要时设计最小实验，说明要改变的单一变量、成功或失败信号，以及后续需要的数据。

---

## 1. 总体架构 ✅

```
用户端(Tauri 桌面)  →  管理端(Web 网关/BFF，部署在服务器)  →  第三方API(OpenAI/Claude/Gemini/简梦…)
   只认识"服务器地址"      持有所有真 key                       各家私有协议
   不碰第三方 key          负责翻译/转发/计费/对象存储
   catalog 远程下发        规范化请求/状态/结果
   声明式 JSON 插件
```

- 用户端**只与管理端通信**，绝不直连第三方 API；提示词正文只存服务端（客户端按 templateId 调用）。
- 管理端负责：翻译/转发、计费、对象存储（OSS）、全局唯一资产 id 分配、四态状态机归一。
- 模型/模板/节点均从 `catalog` 下发并本地缓存，热更新、零发版。

---

## 2. 用户端 ↔ 管理端 通信协议 v1 ✅

鉴权：所有请求 `Authorization: Bearer <API 密钥>`（accessKey，用户级身份凭证——注册自动签发、个人中心/管理端可重置；第218轮起为登录与外部 API 对接的唯一凭证，无激活码/机器码语义）。设备区分另经 `x-device-id` 头（随机 UUID，仅用于同时在线设备限制；旧客户端 x-machine-code 头兼容收下）。渠道节点（P3 relay）另用 `ank-` 节点密钥走同协议白名单端点。

### 2.1 目录
```
GET /v1/catalog?since=<version>
→ { version, models[], templates[], nodes[], schemas[] }
```
- `models`: { id, capability, params(schema), cost, costField/costPerUnit/costRules }
- `templates`: { id, name, purpose?, category?, nodeTypes, isDefault, body?(预设类), images? } ← 正文存管理端
- `schemas`: 输出契约 JSON Schema（按 id 引用）

### 2.2 提交生成
```
POST /v1/generate
{ purpose, model, templateId, variables, inputs:{texts/images/videos/audios}, params,
  output:{format,schemaId}, clientTaskId, scheduledAt? }
→ 同步(文本)：{ status:"success", result:{ text, json } }
→ 异步(文本长任务/图/视频)：{ taskId }
```

### 2.3 轮询（四态归一）
```
GET /v1/tasks/{taskId}
→ { status:"queued|running|success|failed", progress, partialText?, result:{ assets[], json? }, error }
```

### 2.4 批量
```
POST /v1/batch → { batchId, taskIds[] }　GET /v1/batch/{batchId}
```
（拓扑排期/幂等/断点续传 ⬜未做，当前逐任务受理+计费）

### 2.5 素材上传
```
POST /v1/assets?prefix=&name=  → { id, url }
```

### 其它端点
`POST /v1/login|heartbeat`（心跳回传积分）、`GET /v1/me`（积分+消耗）、`POST /v1/redeem`（兑换码）、公开 `GET /v1/assets/:id/raw`（供 `<img>` 直读，有 OSS 则 302 直链）。

### 要点 ✅
- **id 是真理，url 是缓存**：生成资产由管理端落 OSS、分配全局唯一单调 id（类型前缀 C/A/G/M/S/P/video/audio/TP + 8 位）；上游临时链接（简梦 6h）由管理端下载转存为永久资产。
- 项目隔离；id 由管理端分配，客户端当不透明值。
- 未完成素材可声明 `{fromTask, part}`（⬜服务端排期未做）。

---

## 3. 数据模型与资产体系 ✅

- **资产分层**：基础资产 + 变体资产（继承、锁 DNA、只变指定项）；编号 C 核心/A 配角/G 群像/M 怪物异兽/S 场景/P 道具（`C01`、`C01A` 变体）。**编号 code 是项目内人读编号；assetId（C00000123）是全局二进制资产 id，引用一律存 assetId。**
- **用户可见五类界面**：角色 / 群像（G，存 `crowds`）/ 场景 / 生物 / 物品；剧本分析按编号前缀自动分流。
- **项目视觉圣经**：项目级风格锚点，所有资产继承；**资产状态账本**：变体新增/作废/临时过滤。
- **资产是项目级实体，分集/分镜只持有 id 引用**（删分镜不删资产本体）。
- 角色带 `voiceHint`（音色提示）+ `voiceUri/voiceAssetId/voiceName`（已实现本地上传音频→OSS 绑定；匹配资产时自动把音频加入素材区并在图例写「@ImageN的声音参考@AudioM」）。
- **变体生成 = 图生图**：LLM 直接产整段变体模板（继承来源+DNA不可变+唯一变化项）；管理端 catalog 配四类各一套变体前缀。
- 自定义类型兜底桶：无映射的资产进表格「自定义类型」分类。

---

## 4. 提示词模板与输出契约 ✅

**模板数据化（权威来源=管理端）**：正文存 `server/data/templates.json`（`TemplateDef`：body/purpose/category/nodeTypes/variables/schemaId/chainNextId 链式/images/isDefault/order），经 catalog 下发；客户端 `catalogStore` 按 `templatesByNode/templatesByPurpose/templatesByCategory/artStyles` 取用。**客户端绝不含提示词正文**。

**模板库（运行时以管理端数据为准，管理端可增删改）**：2026-07-03 实测 version 43 共 9 条——功能 4：`asset.extract.basic`(script.analyze 资产提取·白羊)、`smart.infer.multi`/`smart.infer.single`(storyboard.toVideoPrompt 智能推理 多/单卡)、`script.episodes.basic`(script.analyze 自动分集·内部)；画风预设 3：`style.3d-guoman/2d-hand/realistic`；用户自建 2：`629mumu`(script.analyze)、`zhinengchaifen701`(storyboard.split 智能拆分)。⚠ `asset.prompt.optimize`（出图提示词优化）已不存在（模板数据与客户端引用均无，第85轮审计确认）。⚠ 模板 `nodeTypes` 白名单数据仍是旧节点类型（如 "text"），客户端已弃用该字段、一律按 purpose 过滤（第84轮补充）。启动迁移机制：`补种缺失` + `RESET_VERSION` 裁剪 + `SKILL_REFRESH_VERSION` 定向从 md 强刷指定模板正文 + 删除内置项走墓碑（不复活）。

**`server/skills/`**（提示词 md 原稿，仅 seed/SKILL_REFRESH 时经 `readSkill` 读入；不进客户端打包）。⚠ **2026-07-19 用户定（勿回退）：skills md 已全部过时——提示词正文一律在管理端「提示词模板」页维护（服务器 `data/templates.json` 为唯一权威）；永远不要再 bump `SKILL_REFRESH_VERSION`/`SEED_VERSION`（会用过时 md 覆盖用户线上调好的正文；[templates.ts](server/src/store/templates.ts) 常量处有同款警告）；新增内置模板走补种（只加缺失、不动存量）**。md 仅作历史留档（全新环境首启种子会产出过时正文，需在管理端重调）。

**输出契约 v1**（server catalog schemas）：
- ① `asset.extract.v1`（script.analyze）——每个资产带 **`imagePrompt` 整段出图模板**（LLM 直接产，非槽位合成）；含 visualBible/characters/scenes/creatures/props/episodes/ledger；运行时也接受扁平 `assets[]` 形态（解析器两者都吃，按编号前缀分流）。
- ② `storyboard.v1`（storyboard.split）——`{ episodeIndex, shots:[{index, scriptContent, durationSec}] }`。
- ③ `videoPrompt.v1`（storyboard.toVideoPrompt）——`visualDescription` 保留 `{角色:名}{场景:名}{音频:名}` 公式供客户端正则抽取自动填垫素材。
- 智能推理实际输出 4 字段卡 JSON `[{card_number, original_script, storyboard_prompts, video_prompts}]`，客户端 `parseInferCards` 容错解析（不依赖整体 JSON 合法，支持流式未闭合尾卡）。

**变量约定**：`{{原文}}{{视觉风格}}{{角色列表}}{{场景列表}}{{物品列表}}{{生物列表}}{{群像列表}}`（客户端 `buildAssetListVars()` 统一下发；模板未引用则忽略）。

---

## 5. 业务工作流（用户端）✅

1. 新建项目：项目名/封面/画风（catalog 画风预设）；选「表格创作」或「画布创作」打开（仅默认视图不同，同一份数据）。
2. 剧本推理：放入剧本 → 剧集拆分（LLM 或快拆：空行/n-1/n-n/场n-n）+ 资产拆分（两按钮独立运行）→ 角色/群像/场景/生物/物品 + 出图提示词推送各界面。
3. 资产界面（AssetWorkbench 五页共用）：生成基础形象/造型变体、提示词优化、上传本地图、绑定音色、主图历史。
4. 视频界面：分集列表 → 智能推理（整集出 分镜+故事板提示词+视频提示词）/智能拆分（只拆原文）/单镜推理；提取资产自动匹配垫素材（优先资产助手选中造型）；故事板图 → 视频生成 → 导出。
5. 画布模式：8 类节点（见 §11，第87轮删「生成故事板」），裂变自动建下游节点，每分集一块独立画布。

**树结构 ✅**：`小说/剧本 → 分集 → 分镜 → 垫素材(资产 id 引用) → 视频`。

**表格 ↔ 画布 = 单数据源双视图 ✅**：底层一份项目数据；表格按键 ⇄ 画布节点一一映射（`purposeRegistry` 固化 `按键→purpose→capability→节点`）；节点自带素材格子，连线是补充。资产模式→画布为**手动单向投影**（视频界面「同步本集到画布」按钮，幂等、按 sourceRef 去重、不触碰手建节点）；**资产不投影**（第81轮：几十个资产节点是卡顿主因，只投 全文→剧集→本集分镜流水线；历史残留资产投影节点随下次同步清理；需要单个资产图时从资产助手拖入）。

---

## 7. 待办清单

1. **genMeta/assetRefImages 净化**：垫图 data: base64 整段落盘 → project.Qiji 可膨胀到百 MB（「三姐妹」161MB 损坏事故根源：保存窗口被拉长，中断即截断；加载也会内存暴涨）。方案：落盘前把 data:/blob: uri 替换为公网 url/缩略图 + 存量项目加载时净化。**已立后台任务**。
2. 服务端任务已 JSON 落盘+启动对账（第89轮，重启不丢计费/视频可续轮询）；**资产 id SEQUENCE 已由 SQLite `asset_seqs` 提供（第105轮，`node:sqlite` 内置）**；logs/tasks/users 等可循同范式后续逐表迁 SQLite（非急）；多实例共享状态才需 Postgres（现单机不需要）；批量拓扑排期（fromTask/part）/幂等/断点续传仍待。
3. 简梦音频上游（待文档）；`audio.tts`、场景/生物/物品 variant 按键未接线（`unwiredPurposes()` 可盘点；`script.toScenes` 第245轮起由大厅「AI 工具箱·小说转剧本」消费）。
4. 客户端重新打包发布（第79轮 `fs:allow-rename` capabilities 变更须随安装包生效）。
5. 小项：`jszip` 依赖未用可移除；`font.css` @font-face 未接入待修；`registry.unregister()` 未实现（下架模型不主动注销 adapter）；模板链式仅两段。
6. 规范变量集命名的进一步统一 ⬜。
7. 火山引擎 超分/去字幕已全链路接入（第90轮二期：`volc-mediakit` 协议+5 内置模型+两模式真提交）；**待生产配置**：管理端「火山引擎 MediaKit」渠道填 API Key（或环境 `VOLC_API_KEY`）+ 重新部署服务端；计费为按次固定价（40/10/15/25/20 积分，管理端可调）。⚠ 上游产出 video_url 仅 24h 有效，已由 rehostVideo 转存 OSS——未配 OSS 时回退上游直链会过期。

---

## 9. 关键设计决定（锁定）

- **整段模板 ✅**（推翻早期"槽位拆分"）：提取 LLM 直接产完整 `imagePrompt`；catalog 出图模板休眠。
- **模型解析零兜底 ✅**：`resolveActiveModelKey`=节点自带→设置面板→空；空则报错，绝不退 mock；无假数据兜底（报错优于编造）。
- **请求参数绝不静默改写 ✅（第188轮用户定稿，全局规则勿回退）**：翻译器对用户请求的 时长/比例/分辨率 等参数**原样透传**——禁止任何 夹钳/就近取档/兜底改值 类「自动判断」（第186/187轮 overseas 时长 Math.min 夹钳把请求 30s 静默砍成 15s、按秒计费却按 30 扣=多扣钱，即反例）。可选档位由管理端模型参数（catalog params）把关，非法值由上游明确报错（失败自动退款）。~~已有渠道的历史夹钳属存量行为~~（**第215轮起豁免废止**：13 个视频翻译器的存量夹钳已全部根除，统一走 [paramPass.ts](server/src/translators/paramPass.ts) 透传），**全部翻译器一律遵守本条**。
- **唯一请求路径 ✅**：表格按键与画布节点共用 `runPurpose → taskCenter 单例轮询`（见 §11.1）。
- **提示词正文只在服务端 ✅**：客户端只发 templateId+variables。
- **画布 NodeSpec 单一事实来源 ✅**：一条 spec 完整描述一类节点（端口/能力/purpose/裂变/参数），加节点只加一条 spec；旧节点由 `sanitizeCanvas` 载入时清除。
- **画布渲染性能规则 ✅（第82轮，勿回退）**：① Canvas 本体与 BaseNode **绝不订阅 viewport**（onMove 每帧写 store，订阅=逐帧全量重渲染）——需要跟随视口的 UI 拆成独立小组件自己订阅（SelectionToolbar）、BaseNode 的 zoom 仅悬停时读取；② `rfNodes` wrapper 按「节点对象引用+zIndex」缓存复用（拖动时只有被拖节点重渲染）；③ ResultView 有 **LOD**（zoom<0.35 时文本/对话/视频/音频换轻量占位块，图片保留作地标；布尔选择器只在跨阈值时触发）+ 节点内文本只预览前 3000 字；④ 画布内随视口移动的元素（节点卡/角标/分组容器）**禁用 backdrop-filter**（平移时每元素每帧对背景重采样+模糊=WebView2 闪烁主因；节点背景本就近不透明，改纯色）——毛玻璃只允许出现在单例悬浮 UI（操作面板/悬停工具栏且仅悬停时挂）；⑤ 连线**不做常驻 dash 流动动画**（SVG stroke-dashoffset 不能 GPU 合成→全部边永远逐帧重绘），流动只给 激活/选中/悬停/续传 边；⑥ 小地图比例尺只按节点 bbox（不并视口，否则平移时整图逐帧重标定="游动"），节点矩形子树 useMemo。不做视口裁剪/节点卸载（第72轮教训：连线消失+逐帧裁剪本身更卡）。
- **多画布 ✅**：每分集一块独立画布（各自节点/连线/视口/撤销栈），无主画布、项目至少一集，`switchCanvas` 切换；投影只进当前激活画布。
- **项目文件原子保存 ✅**：写 tmp → 轮换 .bak → rename 生效；加载失败依次试 .tmp/.bak 恢复，彻底失败弹窗明示（不静默）。
- **自动保存绝不新建项目 ✅**：无 savePath 的自动保存直接跳过（防幽灵「未命名项目」）。
- **S3 对象键仅 ASCII ✅**：中文键在 S3 兼容服务上编码不一致致 AccessDenied（实测教训），键=纯资产 id。
- **`http://*.localhost` 直链=本地文件显示态 ✅（第90轮，勿回退）**：convertFileSrc 在 Win 下产 `http://asset.localhost/...`，形式是 http 实为本地——显示层一律原样直用，任何「按 url 换源/自愈下载」逻辑必须用 `isWebviewLocalUri()` 排除它（换源命中失效 blob 映射=「短暂显示后裂开」）；`localhost:8787` 服务端 /raw 不在此列。
- **服务端热路径写盘规则 ✅（第105轮，勿回退）**：Fastify 单线程——**任何在请求路径上被高频触发的落盘，绝不同步全量重写大文件**（`writeFileSync`+`JSON.stringify` 大对象会冻住 event loop→心跳/登录/admin 全超时，且文件越大越卡）。① 高频、可容忍极小窗口丢失的写（日志索引/任务）走 [db.ts](server/src/store/db.ts) `scheduleSave`（防抖合并 + `fs/promises` 异步写 + 原子 rename），进程退出前 `flushPendingSaves`；② 低频、需即时持久的写（配置/用户）用同步 `saveJson`（已改原子 rename，小文件）；③ **大对象拆分**：像请求日志这种「元信息小、报文大」的数据，索引只留元信息常驻内存、重报文按条外置文件按需读（logs.ts 的 LogMeta/LogDetail 即范式），别把重字段堆进被反复重写的索引里。
- 技术栈：Node+TS+Fastify（同仓 `server/`，复用 contract 类型）；存储 OSS(S3 兼容, 雨云 rains3) + 未来 Postgres。

---

## 10. 开发阶段（状态）

- 阶段0 共享契约 ✅（`src/contract.ts`，server 有副本）。
- 阶段1 用户端接入层 ✅（managedAdapter/catalogStore/声明式插件/集中轮询/设置=服务器地址+accessKey）。
- 阶段2 管理端 ✅ 主体（五端点+真翻译器+admin 控制台+持久化+OSS+计费+兑换码+统计）；余下深化见 §7.2。
- 阶段3-5（文本链路/图像/视频分镜）✅ 主体已在客户端落地（§5 工作流全通）；深化项见 §7。

---

## 11. 代码地图（2026-07-03 第80轮实测校准）

### 12.1 布局（本地镜像 + OSS 权威备份同构）
```
<userDataDir>/user.json / projects.json
<userDataDir>/projects/<projectId>/
  project.Qiji(+.bak 滚动备份/+.tmp 原子写中间态)   # meta+content+资产实体(存 id 引用)
  assets/{character,scene,creature,prop,crowd,video,audio}/<assetId>.<ext>
OSS: qiji/<userId>/<projectId>/...
```
（实际落地：项目在 `AppData\Roaming\com.qiji.canvas\Qiji\projects\<名_时间戳>\`；WebDAV 云同步可选。）

### 12.2 资产 id ✅
- 管理端分配；类型前缀 + 8 位，分前缀单调、永不复用：`C`/`A`→character、`G`→crowd、`M`→creature、`S`→scene、`P`→prop、`video`、`audio`、`TP`(临时)。文件名=id；**OSS 对象键仅 ASCII**。
- `code`(C01，项目内人读) ≠ `assetId`(C00000123，全局)；引用一律存 assetId。

### 12.3 流程
- 生成：管理端跑上游→分配 id→上传 OSS→回 `{id,url}`→客户端 `saveRemoteAsset` 下载本地副本+注册 `assetId↔url↔localPath` 三元映射（显示走本地 `asset://`，请求走公网 url——Tauri CSP 不允许 http(s) 图直显）。
- 上传：客户端 `uploadAsset`（服务端落 OSS+分配 id）→ 本地副本。未配 OSS 时 url 为服务端 `/raw`（上游不可达，属已知限制）。
- 解析 `resolve(assetId)`：本地文件 → 远程 url → 凭 id 重解析。

---

## 9A. 历轮锁定规则速查（⚠ 勿回退清单）

> 从历轮变更记录中机械抽取的全部 ⚠ 标记规则，按轮次倒序。**这是防止改回旧方案的核心清单**，改动相关代码前先在此搜关键词。
> 原始上下文见 §8 对应轮次（已压缩）或 git 历史中的完整版 CLAUDE.md。
> ⚠ **第211轮商业化改造 P1 起，本清单中涉及「链式计费/双扣费/开码积分/签发价/结算价/售价/下游渠道商」的历史规则整体废止**（体系已退役，勿按旧规则恢复任何定价链代码）。

- **第256轮**：**素材增添/匹配的图例同步必须按 @tag 逐条合并，勿回退为整块重建**——整块 `buildLegend(material.name)` 会还原用户改过的资产说明；图例边界必须按条目文法识别，不能再依赖 `\n\n`，否则同行/单换行正文会被吞。只有画布投影等「同编号资产身份已变化」的路径才显式 `preserveExisting:false`。
- **第256轮**：**本地副本恢复必须校验 `localPath`，并用原台账 assetId 下载/登记**——映射存在 `localUri` 不代表文件仍在；有台账 id 时禁止退化成 uri 哈希 id（会产生孤儿映射和重复下载）。异步恢复须绑定 `projectInstanceId`，项目切换后禁止把旧任务写进新项目。
- **第255轮**：**QiQi 是同站两套请求形态并存，按上游模型名分派（`shapeOf`），绝不可混用**——`seedace-2.0-720p` 走 **content 形态**（content[] 多模态数组、支持首尾帧 role、**不传 resolution**、seconds 4–15、音视频参考必须带图）；`sora-v3-933-pro`（933 真人视频，7.26 文档）走 **flat 形态**（扁平 `image_url`+`reference_image_urls`/`reference_videos`/`audio_urls` 只发主字段不用别名、**resolution 必填 720p**、seconds 仅 15、**不支持尾帧**、**素材总数 ≤12 的跨类闸**、音频带图只是「建议」不拦）。两份文档在 resolution / 素材字段族 / 尾帧 三处**正面冲突**，形态错配即被上游 400 拒单。⚠ **两形态的图例引用语法相同**（小写 @imageN，用户实锤；7.26 文档正文没写但底层同源）——都要注入，别因为文档没写就不注入。未知上游名（管理端自建）按 `/sora|933/` 兜底走 flat、其余 content。
- **第255轮**：**QiQi 上游模型名逐字 `seedace-2.0-720p`（文档全篇少一个 n，不是 seedance）**——勿"顺手纠正"，改一个字符即模型不存在（第233轮 congge 同类红线）。加款一律照抄 `GET /v1/models`（Bearer）清单。
- **第255轮**：**QiQi 的 `resolution` 一律不发**（与 BYS 的「一律照发」相反，勿混）——分辨率编在模型名后缀里，文档 §2/§17.4 明示传了会与模型档位冲突拒单；这同时挡住了客户端切模型时残留的档位（如 1080p）导致的整单拒。要开新档=管理端新建模型（上游名照抄站点清单），**别给该模型加 resolution 参数**。
- **第255轮**：**QiQi 的 content[] 项只发 `type/role/<x>_url` 三键，没有 `name`**（编号由各类素材在 content 中的出现顺序决定，text 不参与编号）——勿照抄出海营 overseas 的 name 字段；且**顶层 `prompt` 必须与 `content[0].text` 同文**（文档 §17.1 把「只传 content 不传顶层 prompt」列为常见错误）。素材引用是**小写** `@image1/@audio1/@video1`，经 `qiqiLowerTags` 转写。
- **第255轮**：**QiQi 用参考音频/视频时必须至少 1 张参考图**（文档 §5.4/§17.2：图片是人物/场景锚点，纯音频/纯视频参考请求会失败）——翻译器前置拒单，勿放行让用户白等一次上游失败。`seconds` 是**字符串**（客户端参数键仍 duration），⚠ 缺省补 15 而非文档默认 "4"——与兜底价「每秒价×最长时长」对齐，否则按最长扣费却按 4 秒出片。
- **第254轮**：**换 url 必须把旧 url 归档进 `AssetBlob.pastUrls`，`blobByUri` 必须一并匹配**（[blobSanitize.ts](src/lib/blobSanitize.ts) `mergeAssetBlob`/`blobMatchesUri` 是唯一实现，`registerAssetBlob`/`blobByUri` 勿绕过）——项目里散落的是写入当时的 url 字符串（节点素材/genMeta/assetRefImages），而生成资产落库**不写 srcUri**：url 一被覆盖，旧 uri 就与三元映射失联、自愈永远命中不了、提交仍发旧死链（用户实报「检查完仍然使用过期链接」的唯一根因）。别在别处"重写旧 url 字符串"，那是逐处漏改的死路。
- **第254轮**：**单资产恢复只有 [assetRecover.ts](src/services/assetRecover.ts) `recoverAsset` 一份实现**——`assetHeal.healPublicUrlIfDead`（提交前自愈）与 `assetCheck.checkOne`（手动检查素材）都是它的薄封装，勿再各写一套（此前两份近似重复且能力不对等：heal 有会话缓存却无磁盘兜底扫描、check 有扫描却把两种失败混成一种）。⚠ **「探活换链」这一步不需要本地副本**，勿把 `blob.localPath` 重新加回前置门槛。
- **第254轮**：**`dead`（本机无副本）与 `failed`（有副本但重传失败）必须分开**——重传失败多是对象存储 PUT 抖动（第197轮实锤 rains3 会重置连接），报成「本机无副本」是彻底误导的结论；`reputAsset` 必须带出失败原因（HTTP 码+服务端文案）并**退避重试 1 次**。手动检查一律 `cache:"none"` 真探，不得被提交路径的会话缓存跳过。
- **第254轮**：**`assetAlive` 的 404 = 服务端台账无此资产（missing），不得 catch 成「存活」**——旧写法把 404 当成探测失败走失败安全分支，检查素材会报「正常」而链接其实是死的且无从恢复。其余异常（网络/超时）仍保守当存活。
- **第254轮**：**第三方渠道（LibTV/即梦/ComfyUI）素材 → 本地文件一律走 `resolveMaterialLocalPathOrThrow`**（勿再各自抄一份 `resolveLocalPath`）：**每条素材每次提交都探活**（用户定，`ProbeScope` 只在一次提交内去重）、映射里的 `localPath` **须校验文件仍在磁盘**才用、取不到=**明确报错整单拒**（LibTV/即梦此前的 warn+静默跳过已废止——@ImageN 按素材顺序编号，丢一条会让后面全部引用错位）。
- **第253轮**：**LibTV 加款只动两处、且新款一律追加在 `LIBTV_MODEL_CHOICES` 末尾**——`LIBTV_MODEL_CHOICES[0]` 是 ModelPicker「自动取第一个可用模型」的落点，把新旗舰插到最前=静默改掉存量用户的默认模型。
- **第253轮**：**LibTV 参数档位与素材上限一律按款查 `VARIANT_SPECS`（逐款 `libtv model <modelKey>` 实拉 schema 填表），勿再写全渠道常量**——原先素材上限写死 9/3/3，Seedance 2.5 的 图30/视10/音10 会被静默截断；新款 `legacyClamp:false` 走 `passthruParams`（缺省补默认、非法值原样发出），`clampRatio/clampResolution/clampDuration` 只服务存量的 2.0 与 2.0 Fast、函数体分毫不动。
- **第253轮**：**探 LibTV CLI 新版必须用 `libtv-windows-amd64.zip`（不是 x64），且先拿在用版本号验证探测方法本身**——用错架构段全 404，会误判「上游没有新版」；官方无 latest 端点，只能逐版 range 请求探。升级必先删旧 exe（fetch 脚本幂等跳过），并把 [fetch-libtv.ps1](src-tauri/scripts/fetch-libtv.ps1) 的默认版本一起抬（否则换机/首次打包又拉回旧版）。
- **第253轮**：**即梦 beta 通道的 `version.json` 已 404，勿再按它判版本**——改比对二进制 `Last-Modified`/`Content-Length`，升级后一律 `--version` + `multimodal2video -h` 实锤实际拿到的版本与档位；升级前把旧 exe 备份（滚动通道无法回拉旧构建）。
## 8. 变更记录（第168轮起全文保留；更早只留结论摘要）

- **2026-08-28 第256轮（客户端素材图例增量合并 + .Qiji 本地资产缺失自愈 · 纯客户端 · client tsc 干净 + 1352 vitest 全过（1341→1352，+11）+ vite build 过 · 须客户端重新打包；服务端零改动无需部署）**——用户反馈两条：匹配/拖入素材会清空正文并还原手改前缀；导入不带本地 assets/ 的 .Qiji 后图片空白。根因分别是图例结束边界硬编码为空行、每次整块重建，以及显示链只信 `localUri`、从不校验文件存在，导入缺文件时死路径原样保留。
  ①**图例逐资产合并**（[shotMaterials.ts](src/lib/shotMaterials.ts)）：新增 `splitLegendPrompt`，按 `@ImageN/@VideoN 是 ...` 与声音参考条目识别边界，兼容双换行、单换行、同行正文；`applyLegend/withLegend` 以 @tag 为键保留现有用户说明，只补当前素材清单中缺失的条目。删除时先移除对应条目并重编号其余说明/正文引用，素材重排沿既有 tag 映射保留说明与资产身份一致。
  ②**统一两把边界尺**：[assetMatch.ts](src/lib/assetMatch.ts) 的匹配前剥图例和 [promptCompose.ts](src/lib/promptCompose.ts) 的预设/上游胶囊落位统一复用 `splitLegendPrompt/stripLegend`，不再分别用「行尾」和「首个空行」判断。表格、RTC、画布的素材匹配/拖入均经既有统一入口自然获得新语义。
  ③**本地缺失反向自愈**（新 [projectAssetHeal.ts](src/services/projectAssetHeal.ts)）：`restoreAssetBlob` 先 `exists(localPath)`，缺失则用 blob.url 下载，失败再 `resolveAssetUrl(id)` 取最新 OSS 链；`saveRemoteAsset` 始终传原 assetId，恢复后 merge 回同一映射。批量恢复三路并发，同项目同 id 防重，并用 `projectInstanceId` 阻断切项目后的陈旧回写；恢复完成后把项目、当前画布、素材库、提交快照里的旧 localPath/localUri/url 精确改写并触发自动保存。
  ④**加载 + 显示双挂载**：[projectStore.ts](src/store/projectStore.ts) 在打开/导入后先后台恢复项目映射，再跑既有 libraryHeal；[ResultView.tsx](src/nodes/ResultView.tsx) 的 `useDisplayUri` 改走统一解析，运行中本地文件被删时也能懒恢复。画布投影会把故事板图插到素材首位，属于编号资产身份改变，[canvasProjection.ts](src/services/canvasProjection.ts) 显式关闭说明保留，继续整体重建以防错位。
  ⑤**回归与验证**：新增同行/单换行正文、用户改名后再次拖入、删除后保留其余自定义说明、匹配正文、提示词胶囊落位、现有 OSS 下载、凭 id 换链、导入死引用改写等 **11 条**用例；全量 **126 个测试文件 / 1352 条用例全过**，client `tsc --noEmit` 干净，`npm run build` 通过（仅既有动态/静态混合导入、chunk 体积与 `-0` 比较警告）。
  ⚠ **须客户端重新打包；服务端零改动无需部署。** 已知边界：若映射没有可用 OSS url，且服务端也无法凭 id 解析（台账不存在/对象已清理/离线），客户端不会编造素材，仍保留明确失败态。**待真机 QA**：①导入不带 assets/ 但 assetBlobs 含有效 OSS 链接的 .Qiji，观察资产工作台、分镜素材/主图、画布节点逐步恢复并在重开后保持；②运行中手动移走一张本地副本，重新进入对应显示点确认按同 id 懒下载且只下载一次；③提示词手改「三娘→赵三娘」后依次匹配、拖入李四，确认正文和改名均保留。
- **2026-08-22 第255轮（QiQi（pidoi.com）视频渠道接入 · **2 模型 / 同站两套请求形态** / 新模式「QiQi」·纯服务端 · server tsc 干净 + admin script 语法过（new Function）+ 沙盒冒烟 **142/142**（scratchpad 复制 src+skills + junction node_modules + 独立 data，stub 全局 fetch 零真实上游调用、真实库零触碰）+ **二启幂等**（2→3 启 data md5 零变化；1→2 启差异=全新空库「首启快速初始化、二启补历轮迁移版本号与墓碑」的既有行为，第252轮已记录）+ **部署路径 15/15**（真实 dev 库副本**还原成部署前形状**后一次跑完：模型 158→160、模式 23→24、渠道 28→29，**存量条目逐条 deep-equal 零改动零丢失**）+ dev 8787 热迁移实锤 · 客户端零改动无需打包）**——用户先后提供同站两份官方文档（《Seedance 视频生成 API 调用文档》与《视频生成接口说明·933真人视频》2026-07-26）令「根据 skills，增加渠道 QiQi」，按 qiji-add-upstream-channel 全流程接入。⚠ **两份文档是同站同端点同鉴权、但模型与请求形态各不相同**，且有三处**互相冲突**（resolution 一个明示别传/一个必填、素材字段族 content 数组/扁平、尾帧 支持/明确不支持）——故翻译器按上游模型名分派两套形态（`shapeOf`），绝不可混用。
  ①**上游（Base `https://pidoi.com`，Bearer sk-）**（新 [qiqi.ts](server/src/translators/qiqi.ts)，协议 `qiqi-video`，异步 submit+poll 走统一 VideoDriver）：提交 `POST /v1/videos` → `{id:"task_xxx", object:"video", status:"queued", progress:0}`；查询 `GET /v1/videos/{task_id}` → `queued` / `in_progress`(progress 数字) / `completed`(video_url) / `failed`(error{code,message})；成片另有标准内容端点 `GET /v1/videos/{id}/content`（需 Bearer；任务未完成 409、不属本令牌 404）。文档 §2/§16「每隔 3～5 秒查询一次」→ `BUILTIN_POLL_INTERVALS` 取 **4s**。站方是 **New API 系网关**（错误体 `{"error":{...,"type":"new_api_error"}}`，实测确认）。
  ②**请求形态（content[] 多模态标准格式）**：顶层 `{model, prompt(必填), content[], seconds?, ratio?, generate_audio?, seed?}`；content 项 = `{type:"text",text}` + `{type:"image_url"|"audio_url"|"video_url", role, <同名对象>:{url}}`（role：`reference_image` / `first_frame` / `last_frame` / `reference_audio` / `reference_video`）。⚠ **文档没有 name 字段**（编号由各类型素材在 content 中的出现顺序决定、text 不参与编号）——只发 type/role/<x>_url 三键，**勿照抄出海营的 name**（逐字照文档，第233轮规则）。⚠ **顶层 prompt 与 content[0].text 必须同文**（文档 §5.1 说明其分工，§17.1 把「只传 content 不传顶层 prompt」列为常见错误）。
  ③⚠ **素材引用是小写 `@image1..@image9` / `@audio1..@audio3` / `@video1..@video3`**（文档 §5.3，三类分别编号互不影响）→ 新 `qiqiLowerTags` 把 injectReferenceTags 注入的 @ImageN/@VideoN/@AudioN 统一转小写（简梦P h3 形态 / 苏打水小写 / Dimensio @image_file_N 同先例）。
  ④**守卫（一律明确报错、不发请求、不扣费；绝不静默丢——丢一条即图例整段错位，第118轮）**：未配地址/密钥；图 ≤9、音 ≤3、视 ≤3（first_frame/last_frame 也计入 9 张图总数）；空提示词（含 buildPrompt 无输入时的 `"{}"` 兜底形态，判定在注入图例**之前**——第249轮实锤）；首尾帧方法恰两张图（首帧=「带故事板」firstFrameUrl > 素材第 1 图、尾帧=下一张）且带视频/音频拒；⚠ **用参考音频或视频时必须至少 1 张参考图**（文档 §5.4 与 §17.2：图片是人物/场景锚点，纯音频/纯视频参考请求会失败）——前置拒单，别让用户白等一次上游失败。
  ⑤**参数（§9 第188/215轮定稿：原样透传，绝不夹钳/就近取档/白名单回退）**：duration → 上游 **`seconds` 字符串**（文档 §5.1 明示用字符串 "4"~"15"；客户端参数键仍是 duration、计费恒走 costField=duration，与简梦P h3 形态同处理）；⚠ **缺省补 15（QIQI_DUR_MAX）而不是文档默认 "4"**——与兜底价（cost = 每秒价 × 最长时长，「默认按最高」第134轮）严格对齐，否则「按最长扣费、上游按默认 4 秒出片」= 多扣钱少交货；ratio 显式原样透传、缺省 16:9；generate_audio 显式带可解析值才透传（第122轮规则）。⚠ **resolution 一律不发**（与 congge 视频侧同规，第233轮）：分辨率编在模型名后缀里（`seedace-2.0-720p`），文档 §2/§17.4 明示「推荐不要额外传 resolution，避免模型档位与参数冲突」，传了不一致的档位上游直接 400 拒单——顺带也杜绝了客户端残留档位（切模型时带过来的 1080p）导致的整单拒（冒烟有专项断言）。
  ⑥**flat 形态（同站第二份文档《视频生成接口说明·933真人视频》2026-07-26，模型 `sora-v3-933-pro`）**：扁平字段 `{model, prompt, aspect_ratio(必填), resolution(必填 720p), seconds(必填，仅 "15"), image_url?(主参考图), reference_image_urls?[], reference_videos?[], audio_urls?[]}`——⚠ **只发一套主字段**（文档另给了 `reference_images`/`reference_video`/`audio_url` 等别名，一概不用）；⚠ **不支持尾帧图**（文档 §4.4/§8 明示）→ 显式 method=frames 前置拒单；⚠ **单次请求文件总数（图+视+音）≤12**（文档 §4.4/§8）——除各类上限外另有此**跨类总数闸**；音频参考「**建议**同时提供至少一张参考图」是软措辞（区别于 content 形态的硬约束）→ 不拦，照发由上游裁决（§9：不代上游做判断）；参考视频/音频单条 2–15s、各自总时长 ≤15s 由上游自校验（服务端不探测媒体时长）。⚠ **两形态的素材引用语法相同**（小写 @imageN/@audioN/@videoN——用户 2026-08-22 实锤；7.26 文档正文没写引用语法但底层同源）→ **两形态都注入图例**，flat 的编号顺序 `image_url`(第 1 张)→`reference_image_urls[…]` 与 @image1..N 天然对齐。分派：`shapeOf(upstreamModel)` 显式表（seedace-2.0-720p→content / sora-v3-933-pro→flat）+ 未知名（管理端自建）按 `/sora|933/` 兜底走 flat、其余走 content。
  ⑦**2 模型种子**（[models.ts](server/src/store/models.ts) `qiqi()` 工厂经**补种**入库，未 bump MODELS_SEED_VERSION）：`qq933-sd2.0-720p`「QiQi·Seedance 2.0 720p」（⚠ **上游名逐字 `seedace-2.0-720p`**——文档全篇如此写，**不是** seedance，少一个 n；skill 红线「上游模型名逐字照抄，勿顺手规范化」；参数 duration 4–15（默认 5）/ ratio 六档 / generate_audio；methods omni+frames；**占位价 50 积分/秒、兜底 750**） + `qq933-sora-v3-pro`「QiQi·Sora V3 933 真人 720p」（上游 `sora-v3-933-pro`；参数 duration **仅 15 一档** / ratio 六档，**无 generate_audio**；**不声明 methods**（不支持尾帧=客户端无「方法」下拉）；**占位价 60 积分/秒、固定单价 900**）；两款 matLimits 均 {img:9,vid:3,aud:3}、familyId 经 classifyFamily 自动归 **fam-seedance**（① id 含 "sd2"、② 命中既有 `sora-v3` 规则「全能参考 sora=Seedance 换壳」，无需新规则）；⚠ 两款都**刻意不设 resolution 参数**（各自只有 720p 一档；flat 形态由翻译器恒发 720p、显式值仍原样透传）。
  ⑧**注册面 15 点全登记**：Protocol 联合 + BUILTIN_PROTOCOLS + VIDEO_DRIVERS + BUILTIN_POLL_INTERVALS(4s) + dispatch case（与既有视频协议并列走 `createVideoPollingTask(..., "video", {intervalMs})`）+ upstream fallback（`config.qiqi`，env `QIQI_BASE_URL`/`QIQI_API_KEY`）+ 模式 qiqi「QiQi」（[modes.ts](server/src/store/modes.ts) **v24，版本号与条目一次编辑**——红线）+ 渠道 `ch-qiqi`「QiQi（pidoi）」（baseUrl 填根域不带 /v1、apiKey 留空）+ 模型工厂与种子 + classifyFamily（自动归类，零改动）+ errorScrub（品牌词 `QiQi`（=模式对外名经占位符保护，改名后自动开始被擦）与 `pidoi` + 域名 `pidoi.com`；⚠ 与我方品牌 Qiji 字面不同不会误伤）+ REHOST 白名单 `.pidoi.com`/`pidoi.com` + admin PROTOCOLS 下拉 + .env.example 段 + paramPass helper。
  ⑨**验证**：server tsc 干净 + admin script `new Function` 语法过 + **沙盒冒烟 142/142**（**A 种子 34**：模式/渠道/两模型 协议·能力·上游名逐字·素材上限·方法·家族·参数键·时长档·计费（①5s=250·15s=750·兜底750 / ②15s=900）·resolveUpstream·**两款均无 resolution 档**；**B catalog 4**：两款在列 + **均不泄漏上游真名**；**C content 形态提交 26**：URL/鉴权头/model/**seconds 字符串且缺省补 15**/顶层 prompt 与 content[0].text 同文/content 结构与 role/素材顺序/**content 项无 name 字段**/**小写 @image·@video·@audio 且无大写残留**/**越档 30s 原样透传**/数字串归一/档外比例原样发出/**客户端残留 resolution 也不发**/故事板图追加末尾/首尾帧 role first_frame·last_frame/**无 flat 字段串味**；**D flat 形态提交 20**：model/**resolution 必发 720p**/aspect_ratio 必发/seconds 字符串/**无 content 数组不串味**/无素材时不发 image_url/**无 generate_audio**/主图 image_url=第1张 + 其余进 reference_image_urls/reference_videos/audio_urls/**只发一套主字段无别名**/**小写图例编号与 image_url→reference 顺序对齐**/故事板追加末尾/显式 resolution 与 duration 原样透传/**未知名分派（sora·933→flat、其余→content）**；**E 守卫 33**：未配地址与密钥、空 `"{}"`、图超 9/视超 3/音超 3、content 形态**纯视频与纯音频参考各自拒单**、首尾帧 1图/3图/带视频 三负例、**flat 尾帧方法被拒**、**flat 素材总数超 12 被拒**——每条都断言「零请求」；放行正例：content 恰好 9/3/3、flat 恰好 12 个文件、**flat 纯音频参考放行**（文档只是「建议」带图，不代上游判断）；**F 错误映射 5**：400 透出上游 message、401 密钥文案、429 限流、200 无 id、**网络异常只发 1 次不自动重试**（文档 §16 明示重复提交会产生重复任务）；**G 轮询 16**：queued/in_progress 56%/**processing（933 文档状态词）**/**未知状态词不终态**/completed 取片/**本站域附 Bearer·第三方 CDN 绝不附头**/**缺 video_url 回退内容端点**/failed 透出/500 与 429 不终态/404 终态失败/网络抖动不终态/信封形态；**H errorScrub 5**：链接隐藏、**模式名 QiQi 保留**、裸域名（含子域）隐藏、既有渠道 BYS 回归） + **二启幂等**（2→3 启 data md5 零变化；1→2 启差异=全新空库既有行为，见标题） + **部署路径 15/15**（真实 dev 库副本**还原成部署前形状**（剥 qiqi 三条 + modes seedVersion 回 23）后一次跑完：三条新条目正确补种、seedVersion=24、两款上游名与家族正确，**存量 158 模型 / 23 模式 / 28 渠道逐条 deep-equal 零改动零丢失**） + dev 8787 重启热迁移实锤（模型总数 158→160，两款全字段与 modes v24 / ch-qiqi 落库正确，/health 200）。⚠ 过程记录：两次动种子代码前都按红线先停了本机 tsx watch（编辑中间态会被热重启种进真实 dev 库，第216/217轮教训），全部编辑完 tsc 过后才重启。
  ⚠ **须重新部署服务端**（首启自动补种 QiQi 模式 v24 + 渠道 + 1 模型；**部署后到管理端「QiQi（pidoi）」渠道填 sk- 密钥**（控制台→令牌创建），或环境 `QIQI_API_KEY`——不填则提交明确报「未配置上游密钥」）；**客户端零改动无需打包**（模式/家族/模型/参数档全走 catalog 热更 ≤30s）。**运营注意**：①**两款均为占位价**（50 / 60 积分每秒，按同类 720p 线的 元价×100 折算尺估），上线前管理端定真价——⚠ 该站**价格无免鉴权来源**（`/api/pricing` 需登录态 access token/Cookie，文档只说「以模型广场实时展示为准」），须登录站点看模型广场或小额真单对账；②**两份文档各自都写「当前仅支持」自家那一款**——可能是两条并行产品线，也可能其一已下线；建议部署后用密钥拉一次 `GET /v1/models`（Bearer）核实两款是否都在线，不在线的在管理端停用即可；③站内其余款=管理端在 ch-qiqi 新建零代码（协议 qiqi-video、上游名照抄清单**逐字勿改**）——⚠ **新款走哪套形态由翻译器按名分派**（`/sora|933/`→flat，其余→content），形态不对会被上游 400 拒单，接不常规的新名时先看 `shapeOf` 注释；④Seedance 款**能垫视频/音频**（与 BYS 相反）但必须同时带至少 1 张参考图；933 真人款固定 15 秒、不支持尾帧、素材总数 ≤12。**待真机 QA**：两款各跑小额真单（Seedance 款：纯文生 / 多图+音视频全能参考 / 首尾帧；933 真人款：多图+音视频全能参考）、小写 @imageN 引用被上游正确识别、成片 `video_url` 转存 OSS（失败时看请求记录 ④ 段实际托管域回补 `REHOST_ALLOW_SUFFIXES`）、进度百分比在客户端的显示。