# Qiji 漫剧创作平台 · 需求规格文档（Living Spec）

> 本文档是用户端与管理端开发的**唯一事实来源**。每轮沟通后更新。
> 状态标记：✅已锁定　🟡讨论中　⬜待定

最后更新：2026-06-21（全量代码复审 + 文档校准，见 §11 代码地图）

---

## 进度快照（新会话先读这里，详情见 §10/§8）

**架构**：用户端(Tauri/React, 项目根) → 管理端网关(`server/`, Fastify+TS) → g-aisc 聚合网关(`https://sub.g-aisc.com`，一把 sk- + Bearer，兼容 OpenAI/Anthropic/Gemini 三协议)。

**已完成**
- 阶段1：删 5 旧适配器+catbox；插件加载器声明式 JSON(内置 9 节点 .js→.json)；集中轮询收口为单例 `src/services/taskCenter.ts`(+`taskTracker.ts`，画布表格共用；原 `nodeTaskTracker.ts` 已删)；设置改「服务器地址+accessKey」；删旧激活验证。
- 阶段2 `server/`：五端点 `/v1/catalog|generate|tasks|batch|assets` + `/v1/login` `/v1/heartbeat`；真翻译器(OpenAI 文本/图、Claude tool-use 强制结构化(Bearer)、Gemini 图)，图像走真异步任务，echo/stub 兜底；模型数据化(按 protocol 路由，catalog 由模型库构建+version 自增)。
- 管理端控制台 `/admin`(ADMIN_TOKEN 鉴权，自包含单页)：用户增删改查+启停+重置 accessKey、模型加载+编辑翻译格式、请求记录(时间/完成/用户/purpose/完整请求/响应/结果)。
- 用户端登录页+30s 心跳，未登录/被禁用不可用；资产 `/v1/assets/:id/raw` 公开供 <img> 直读。
- 持久化：`server/data/`(users/models/logs)，已 gitignore。已修 catalog 304 被误判为错误。

**质量**（2026-06-21 复审实测）：用户端 `tsc --noEmit` 干净、`vitest run` 60 测试全过(7 文件)；server `tsc --noEmit` 干净。

**⚠ 版本控制现状**：阶段1/2 的大量改动**尚未提交**——本 `CLAUDE.md`、整个 `server/`、`src/contract.ts`、`src/lib/purposeRegistry.ts`、新建的 `managedClient/managedAdapter/purposeRunner/taskCenter/promptComposer/catalogStore/connectionStore` 等仍是 `??`(untracked)；旧适配器/插件 `.js`/`ActivationOverlay`/`ProjectSettingsModal`/`services/auth.ts`/`config.ts` 是 `D`(已删未提交)；最近一次 commit `badbd5a` 仍是旧画布形态。**建议尽快分阶段提交固化**。

**运行**：`cd server && npm i && cp .env.example .env`(设 ADMIN_TOKEN、GATEWAY_API_KEY)→`npm run dev`(/admin 默认 admin-dev)；项目根 `npm run dev`(登录填 http://localhost:8787 + accessKey 首启默认 dev-key)。

**待办**：简梦视频/音频上游(待文档)；Postgres(资产id SEQUENCE)+S3(资产现存内存)；批量拓扑/幂等/断点续传；额度扣减✅(/generate+/batch 均按 model.cost 扣，余额不足拦截)；可选请求记录加上游原始响应。

---

## 0. 合作方式 ✅

- 中文沟通。
- **先把需求/协议/格式完全确定，再一次性开发**（用户端 + 管理端同时做）。
- 本文档代替"长期记忆"（用户未开启 Claude 记忆功能），作为跨轮次的共识载体。
- 用户邀请：知识面有限，遇到更好的方案请主动提出建议。

---

## 1. 总体架构 ✅

```
用户端(Tauri 桌面)  →  管理端(Web 网关/BFF，部署在服务器)  →  第三方API(OpenAI/Claude/Gemini/简梦…)
   只认识"服务器地址"      持有所有真 key                       各家私有协议
   不碰第三方 key          负责翻译/转发/计费/对象存储
   catalog 远程下发        规范化请求/状态/结果
   声明式 JSON 插件
```

- 用户端、管理端是**两个独立程序**。管理端是 Web 形式，部署到服务器；用户端是 Tauri 桌面应用，只需知道服务器地址即可连上。
- 用户端**只与管理端通信**，绝不直连第三方 API。
- 管理端负责：翻译/转发到第三方、计费、对象存储备份资产、分配全局唯一资产 id、规范化状态机。
- 插件形态：**声明式 JSON**（不执行远程 JS，企业级安全）。用户端的模型列表、提示词模板、节点定义都从管理端 `catalog` 拉取并本地缓存，热更新、零发版。

---

## 2. 用户端 ↔ 管理端 通信协议 v1 🟡

鉴权：所有请求 `Authorization: Bearer <userAccessKey>`（用户级，管理端签发，映射到可用模型/积分/权限）。

### 2.1 拉取目录（远程更新入口）
```
GET /v1/catalog?since=<version>
→ { version, models[], templates[], nodes[], schemas[] }
```
- `models`: { id, capability, params(schema), cost }
- `templates`: { id, name, capability, （可选 body 预览） }　← 正文存管理端
- `nodes`: { type, label, icon, ports, paramsSchema }
- `schemas`: 输出契约 JSON Schema（按 id 引用）

### 2.2 提交生成
```
POST /v1/generate
{
  purpose,        // 位置和作用：script.analyze / storyboard.split / asset.character.image / video.generate …
  model,          // 逻辑模型 id，如 gpt-5.5
  templateId,     // 选中的推理模板（来自 catalog）
  variables,      // 喂给模板的变量（视觉风格/原文/历史情节…）
  inputs: {       // 素材：id 为真理，url 双重保险，支持任务依赖
    texts:[{id,url?}], images:[{id,url?}], videos:[{id?,url?,fromTask?,part?}], audios:[…]
  },
  params,         // 模型字段：duration / aspect_ratio / size …
  output:{ format:"json|text", schemaId },  // 期望返回格式
  clientTaskId,   // 幂等 + 链路追踪
  scheduledAt?    // 定时提交；空=立即
}
→ 同步(文本)：{ status:"success", result:{ text, json } }
→ 异步(图/视频)：{ taskId }
```

### 2.3 轮询（四态归一）
```
GET /v1/tasks/{taskId}
→ { status:"queued|running|success|failed", progress, submittedAt, finishedAt,
    result:{ assets:[{ id, type, url }], json? }, error }
```
管理端把第三方 vendor 的 queued/dispatched/processing/running/completed/failed 等映射成这四态。

### 2.4 批量提交（并发容灾）
```
POST /v1/batch
{ tasks:[ <generate body> … ] }   → { batchId, taskIds[] }
GET  /v1/batch/{batchId}          → { tasks:[{taskId,status,progress}], summary }
```
- 管理端做：拓扑排期（按 `fromTask` 依赖）、并发上限、按 `clientTaskId` 幂等去重、崩溃后断点续传。

### 2.5 素材上传
```
POST /v1/assets  (multipart 或 base64)  → { id, url }
```

### 协议补充要点 ✅
- **a 对象存储**：所有生成资产由管理端备份到图床/对象存储，分配**全局唯一、单调递增、永不复用**的 id，返回公网 url；用户端再保存本地。
- **id vs url**：**id 是真理**（持久、可重解析）；**url 是缓存/快捷方式**，会过期（简梦视频结果链接仅存活 6 小时），失效后用 id 向管理端重新解析。
- **b 项目隔离**：项目之间资产不互通；但 id 全局唯一。id 由管理端分配，用户端当不透明值处理。
- **d 未完成素材等待**：输入素材可声明 `{fromTask, part:"tail_frame|last_2s|full"}`，管理端在上游完成后解析再提交下游，绝不丢素材。
- **e 定时提交**：每任务带 `scheduledAt`，管理端按时间 + 依赖拓扑自动排期。

---

## 3. 数据模型与资产体系 🟡

来源：`skills/剧本/资产拆分.md`（远比"四类资产"复杂）。

- **资产分层**：每类分**基础资产**与**变体资产**；变体继承基础、锁定 DNA、只允许指定项变化（父子 lineage）。
- **编号体系**：C 核心角色 / A 配角 / G 群像 / M 怪物·异兽 / S 场景 / P 道具。示例 `C01`、`C01A`(变体)、`P01`、`S01`。
- **项目视觉圣经**：项目级统一风格锚点，所有资产继承，禁止漂移。
- **资产状态账本**：跨章节追踪——变体新增、旧资产作废、临时资产过滤记录。
- **临时资产过滤**：只提取核心且高频出现的资产；一次性/与后续无关的元素不出图。

**已锁定 ✅**：v1 数据模型**一步到位支持完整体系**（基础/变体+继承、视觉圣经、状态账本、临时过滤、编号），内容渐进填充。
- **用户可见四类**：角色 / 场景 / 生物 / 物品（对应界面侧栏）。群像(G) 并入角色，用 `importance:"crowd"` 标记，不单设界面。
- **资产是项目级实体 + 分集按引用使用 ✅**：资产存项目级资产库、全局唯一、跨分集复用（锁 DNA/继承视觉圣经）；分集/分镜只持有资产 **id 引用**（指针），删分镜不删资产本体。树里 `分集→资产` 是"引用了哪些"，非"归该集所有"。
- **自定义类型兜底桶 ✅**：用户新建/上传、不属于角色/场景/生物/物品、在画布也无对应节点映射的资产，进表格模式的「自定义类型」分类存放。
- **角色带"音色"字段**（界面有，用于后续 TTS）：`voiceHint`。
- **变体生成 = 图生图**（已由界面图确认）：基础形象图（文生图）→ 造型预设/变体（基础图 + 变体描述 + "保 DNA 不变"默认前缀，走图生图 image-edit/fusion）。
- **变体默认前缀**：源自"融图—人物换装"，见《资产提取提示词 v0.1》第四节。🟡待商讨：是否做成管理端可配全局变量、各资产类型是否各一套前缀。

---

## 4. 提示词模板与输出契约 🟡

**模板已数据化（权威来源 = 管理端）**：模板正文存 `server/data/templates.json`（`TemplateDef`：body/purpose/category/nodeTypes 白名单/variables/schemaId/chainNextId+chainPipeVar 链式/images 参考图/isDefault/order），经 `/v1/catalog` 下发，客户端 `catalogStore` 按 `templatesByNode/templatesByPurpose/templatesByCategory/artStyles` 取用。内置 3 类：①`asset.extract.basic`(purpose=script.analyze)；②`storyboard.split.basic`(purpose=storyboard.split)；③画风预设 `style.3d-guoman/2d-hand/realistic`(无 purpose、不可执行，仅作视觉风格描述符)。

**`skills/` 文件夹（2026-06-21 第26轮已落）**：按**流水线步骤分目录**，每步一份 md 提示词（Word 原稿已转 md 并删除）：
- `skills/小说2资产/资产拆分.md` → purpose `script.analyze`（资产提取，**整段出图模板**）
- `skills/剧本2分镜/剧本划分分镜.md` → purpose `storyboard.split`（分集剧本 → 大分镜卡）
- `skills/分镜2视频/视频分镜提示词.md` → purpose `storyboard.toVideoPrompt`（分镜 → 视频提示词，第26轮新增）

这些 md 是**权威提示词正文的来源**，待录入管理端 `templates.json`（DEFAULT_TEMPLATES）；运行时模板走 catalog 下发。

**输出契约 v1（2026-06-21 第26轮锁定，四项决策：整段模板 / 字段锁定 / 独立 toVideoPrompt purpose / 保留 `{角色:}{场景:}{音频:}` 公式）**：

① `asset.extract.v1`（`script.analyze` 输出，**整段模板版**）——每个资产带 `imagePrompt`(完整出图提示词，LLM 直接产)：
```jsonc
{ "visualBible": { "style","styleAnchors[]","negativeBaseline[]" },
  "characters": [{ "code":"C01","name","importance":"core|support|crowd","voiceHint","firstAppearance",
                   "imagePrompt":"<完整出图模板>",
                   "variants":[{ "code":"C01A","label","inheritsFrom":"C01","imagePrompt":"<完整变体模板>" }] }],
  "scenes":[{ "code":"S01","name","imagePrompt","variants":[] }],
  "creatures":[{ "code":"M01",… }], "props":[{ "code":"P01",… }],
  "episodes":[{ "index","title","summary" }],
  "ledger":{ "newVariants[]","deprecated[]","filteredTemp[]" } }
```
编号 C(核心)/A(配角反派)/G(群像→importance:crowd)/M(怪物异兽=creature)/S(场景)/P(道具)。

② `storyboard.v1`（`storyboard.split` 输出）——大分镜卡：
```jsonc
{ "episodeIndex":1, "shots":[{ "index":1, "scriptContent":"<含【对话】【旁白】等标签的剧本内容>", "durationSec":15 }] }
```

③ `videoPrompt.v1`（`storyboard.toVideoPrompt` 输出，第26轮新增）——视频生成提示词，`visualDescription` **保留代码公式**供自动素材匹配：
```jsonc
{ "shots":[{ "id":"card_01", "durationSec":15,
             "visualDescription":"…{角色:楚长生} 走入 {场景:阎王殿}… {音频:楚长生}的音色[怒]:\"…\" 音效:\"剑鸣\"…" }] }
```
客户端正则抽 `{角色:名}`/`{场景:名}` → 自动填分镜垫素材槽（§5 第5步）。下游 `video.generate` 吃 `visualDescription` + 匹配到的资产图。

**仍待定**：规范变量集命名（`{{text}}/{{requiredAssets}}/{{context}}/{{视觉风格}}` 等统一）。


## 5. 业务工作流（用户端）✅（来自首轮需求）

1. 新建项目：项目名、封面(选填)、默认大模型、作品风格。**新建后选择以「表格创作」还是「画布创作」打开**（仅默认落地视图不同，背后同一份数据）。
2. 剧本推理：放入小说/剧本 → 选推理模板 → 分析 → 推出角色/场景/物品/生物及其资产提示词、可分多少集，推送到各界面。
3. 各资产界面：查看推理结果 → 生成三视图/场景/生物/物品资产。
4. 视频界面：查看分集 → 选模板（单分镜最大时长/需分多少分镜）→ 单集推理成**分镜** + 分镜提示词。
5. 每个分镜按提示词自动匹配资产（角色/场景/生物/道具），落入分镜的**素材格子（垫素材）**。
6. 生成视频。

**树结构 ✅**：`小说/剧本 → 分集 → 分镜 → 垫素材(资产 id 引用) → 视频`。分集为第 2 级（视频界面左侧 001~007 列表）。

**表格 ↔ 画布 = 单数据源双视图 ✅**：底层只有一份项目数据（资产库 + 分集/分镜 + 引用关系）；表格按"表"渲染、画布按"节点+连线"渲染，任一视图改的是同一份数据，另一视图自然同步，**不存在 A→B 拷贝**。两种打开方式只是默认视图不同。先开画布新建的资源，表格同样同步。

**垫素材两端共有 ✅**：分镜（表格里素材1–5 槽位 / 画布里视频·图片等节点的素材格子）都支持「从资产库选」+「上传本地文件」。

**节点素材格子 vs 连线 ✅**：节点自带素材格子，用户可直接在格子里选/传资产；**连线是补充（显式声明依赖），不是喂素材的唯一方式**，不连线节点也能调用资产。表格槽位 / 画布节点格子 / 画布连线 三者写的是同一份「本节点引用了哪些资产 id」关系。

**表格按键 ⇄ 画布节点 一一映射 ✅**：表格每个动作按键对应画布一个节点类型（如`资产分析`键 = 文本类·资产分析节点；`匹配素材`/`故事板生成`/`视频生成`/`开始分镜`/`批量提取` 各对应一节点）。落地时拿 `nodeMetadata`/`pluginRegistry` 跟表格按键逐个对齐。

- 管理端职责：用户管理、大模型列表管理、最新提示词推送。

---

## 6. 现有代码处置（接入层重做）✅方向

- **删**：channelAdapter 的 vendor 分支、seedance/gvlmText/gvlmScript/libImage/libAudio 五个适配器、各处重复的 setTimeout 轮询、catbox 上传 hack、剧本分析里的 Windows 硬编码路径与"阎王殿/青铜古剑"兜底。
- **建**：单一 `ManagedAdapter`（只说本协议）、启用 `taskTracker` 集中轮询、`catalog` 客户端（拉取/缓存/版本比对）、声明式插件加载器。
- **改**：设置界面"渠道/baseUrl/各家 key"→"服务器地址 + accessKey"。
- UI：大致布局不变，实现层放手重构（Figma 仅设计稿）。

---

## 7. 待定问题清单 ⬜

1. 输出格式：方案 C（保正文+强制 JSON）确认？
2. 资产模型深度 v1：模型做满+内容渐进，还是先扁平四类？
3. 分镜输出 schema 字段确认？
4. 规范变量集命名（待提案）。
5. 管理端技术栈（Node/其他？）、对象存储选型（自建/S3/R2/七牛…）。
6. 用户级 accessKey 的签发与权限模型细节。

---

## 9. 关键设计决定（开发期锁定）

- **❌已推翻：槽位拆分**（2026-06-21 第26轮用户拍板「以提示词为准、整段模板」）。原方案是「提取 LLM 只产槽位 + catalog 出图模板确定性合成」；现改为 **LLM 直接产出整段出图模板**（见 `skills/小说2资产/资产拆分.md` 原文：每个资产输出完整「统一风格前缀+DNA锁定+画面要求+禁止红线」）。**后果**：catalog 的 `imageTemplates`(出图模板) 与 `src/services/promptComposer.ts`(槽位合成) 退居**休眠**(不在关键路径，保留不删)；`asset.extract.v1` 每个资产带 `imagePrompt`(完整出图提示词) 字段，详见 §4。变体同理由 LLM 直接产整段变体模板(继承来源+DNA不可变+唯一变化项)。
- **变体前缀 ✅**：管理端可配全局变量；**角色/场景/生物/道具各一套**前缀（非通用）。
- **表格/画布单数据源双视图 ✅**：两视图操作同一份项目数据，无 A→B 拷贝；表格按键 ⇄ 画布节点一一映射；节点自带素材格子可直接选/传资产，连线为补充。资产项目级、分集按 id 引用使用。详见 §5。
  - **映射地基已落 ✅**：`src/lib/purposeRegistry.ts`——`PURPOSE_REGISTRY: Record<Purpose,PurposeMeta>`（类型强制穷尽全部 purpose），固化 `表格按键→purpose→capability→画布节点`，含 `nodeType/assetType/isVariant/buttonLabel/view`，`unwiredPurposes()` 列出当前覆盖空洞。表格视图与节点侧都从此表读语义。（**实测 14 个 purpose**：原 13 个含 `script.toScenes`，2026-06-21 第26轮新增 `storyboard.toVideoPrompt`；unwired=5：script.toScenes + 场景/生物/物品变体 + audio.tts。）
  - **执行管线合并·样板已落 🟡**：新增 `src/services/purposeRunner.ts`——`runPurpose(purpose, {prompt/variables/params/onProgress})`，按 purposeRegistry 取 capability/nodeType → resolveAssetModelKey → getAdapter → submit → **复用通用 TaskTracker 集中轮询**（一次性 Promise 包装），表格无需造画布节点；无模型返回 `no_model` 供本地 mock 兜底。已改 `Frame1693.handleAnalyzeScript` 走 runner、删其自建 30×1s 轮询（tsc/build/60 测试全过）。
    - **已推广 4 资产界面 ✅**：16285/16550/16780/161000 的 `handleGenerateImage` + `handleGeneratePresetImage`（共 7 段）改走 `runPurpose("asset.{character|scene|creature|prop}.image")`，删尽各自 30×1s 轮询；保留 `activeImageModel`(=run.modelKey)+Unsplash 兜底（no_model 时走兜底）。tsc/build/60 测试全过。
    - **收口完成·画布表格共用唯一路径 ✅**：新增单例 `src/services/taskCenter.ts`（一个 TaskTracker + 按 taskId 分发 onUpdate 回调），purposeRunner.awaitTask 改用它。`runPurpose` 加 `modelKey` 覆盖（画布传已解析的节点模型）。`pluginRegistry.defaultNodeExecute` 重写为：resolveActiveModelKey→预检→`runPurpose(purpose, {modelKey, onProgress})`→成功分支落资产库+回写 resultAssetId（原 nodeTaskTracker 逻辑搬入）。purpose 取 `params.purpose || NODE_DEFAULT_PURPOSE[node.type]`（约束 meta.nodeType===节点类型，提交类型不变）。**删除 nodeTaskTracker.ts**（dead）。至此画布节点与表格按键共用 runPurpose→taskCenter 单例轮询；batchExecutor 仍为独立批量协调器。tsc/build/60 测试全过（画布节点执行待真机回归）。
    - **变体（asset.*.variant 图生图）部分落地 🟡**：server 端 ① `buildPrompt` 检测 variant purpose→用 catalog 变体前缀(保DNA，填 {{变体描述}}{{视觉风格}}+底图描述)合成提示词(echo 验证：`保持人物DNA不变…红色重甲…维持3D国风…`)；② Gemini 图像翻译器接底图(`req.inputs.images[0]` 按 id 取 server 资产字节作 inlineData→图生图/编辑；无底图退化文生图；tsc 验证，运行需真 Gemini)。catalog 加 `getVariantPrefix`。**待办**：客户端变体按钮(Frame16285 等 handleGeneratePresetImage)走 runPurpose 传 variant purpose+底图(需先把客户端资产图变成 server 资产 id)+变体描述；OpenAI /images/edits 底图路径；Storyboard storyboard.split/video.generate 接 runPurpose；Frame1693 mock 阎王殿/青铜古剑清理。
- **管理端技术栈（🟡推荐待确认）**：Node + TypeScript + Fastify（与用户端共享契约类型）；可选 NestJS。
- **存储/DB（🟡推荐待确认）**：对象存储走 S3 兼容接口（可换 R2/MinIO/OSS/七牛）；DB 用 PostgreSQL，资产 id 用 SEQUENCE 实现全局单调永不复用。

## 10. 开发阶段

- 阶段0 共享契约：✅交付 `qiji-contract.ts`（协议+资产schema槽位版+catalog类型，两端共用）。
- 阶段1 用户端接入层：✅交付。步骤A(纯加法)：connectionStore/managedClient/catalogStore/promptComposer/managedAdapter。步骤B(切换)：删 5 旧适配器+catbox、channelAdapter 直连机器；模型源切到 catalog；插件加载器改声明式 JSON（内置 9 个节点转 `.json`，去 new Function/createTask/queryTask/`*.js` glob）；新增 nodeTaskTracker 集中轮询（删 pluginRegistry 两处重复 setTimeout 循环）；设置界面渠道 UI 改「服务器地址+accessKey」+ 拉取目录；App 启动改 syncCatalog/syncManagedAdapters。
  - 遗留待办：settingsStore.channels/modelRequests/fetchModelsFromChannel 字段保留为休眠态（不再有 UI）；batchExecutor 仍用自有批量轮询（非重复，留作批量协调）；catalog.nodes→画布节点的注册留待 catalog 落地；Frame*.tsx 内 mock 数据(阎王殿/青铜古剑)与假延时属阶段3 清理。
- 阶段2 管理端骨架：🟡进行中。步骤A(骨架+一真翻译器)已交付 `server/`（同仓子目录，复用 `src/contract.ts`）：Fastify + 5 端点(/catalog /generate /tasks /batch /assets) + 鉴权(Bearer accessKey) + 内存存储(任务四态时间机/资产单调id序列) + OpenAI 兼容文本真翻译器(结构化输出 json_schema 强制) + echo 文本(免密钥联调) + 图/视频/音频占位异步任务。curl 冒烟五端点全过。
  - 步骤B 已接 Claude 文本翻译器(@anthropic-ai/sdk + Messages API；output.format=json 用 tool-use 强制：catalog schema 当工具 input_schema + tool_choice 强制 + 读 tool_use.input；catalog 加 claude-opus-4-8；按 model 前缀路由)。删除用户端旧激活/管理端验证(services/auth、ActivationOverlay、LoginPage、孤立 services/config)，鉴权改由 serverUrl+accessKey 承担。
  - 步骤B 接入真实上游：用户提供 g-aisc 聚合网关文档(一把 sk- 密钥+Bearer，兼容 OpenAI/Anthropic/Gemini 三协议)。server config 改单网关(GATEWAY_BASE_URL+GATEWAY_API_KEY，三协议默认共用，可分协议覆盖)；catalog 换真模型(文本 gpt-5.5/5.4/5.4-mini/5.3-codex + claude-opus-4-7/sonnet-4-6/haiku-4-5；图像 gpt-image-2 + gemini-3-pro/3.1-flash-image；echo/stub 兜底)；真图像翻译器(OpenAI /v1/images b64_json + Gemini generateContent inlineData)走真异步任务(createRunningTask→后台落资产→completeTask)；Anthropic 改 Bearer(authToken)。无密钥时各路径优雅失败，echo/stub 仍通；tsc 通过、五端点+真/桩路径 curl 冒烟通过。
  - 步骤B 管理端可视化(已交付)：文件持久化(server/data: users.json/models.json/logs.jsonl)。控制台 /admin(ADMIN_TOKEN 鉴权，自包含单页)：①用户增删改查+启停+重置 accessKey；②模型加载——增删改+编辑翻译格式(protocol/upstreamModel/baseUrl/apiKey 覆盖)，模型数据化后 dispatch 按 protocol 路由、catalog 由模型库构建(version 自增)；③请求记录——/generate 记录请求时间/完成时间/用户/purpose(在哪一步)/完整请求/完整响应/结果(截断base64)，异步图像后台回填。用户端：登录页(serverUrl+accessKey)+30s 心跳，未登录/被禁用不可用(/v1/login /v1/heartbeat)；requireAccessKey 改读用户库(启用校验)。资产 /raw 改公开(供 <img> 直读)。
  - 步骤B 余下(待加深)：简梦视频/音频上游(待文档)+Postgres(资产id SEQUENCE，替换 JSON 文件)+S3(资产持久化，现为内存)+批量拓扑排期(fromTask/part)/并发/幂等/断点续传+用户额度计费扣减。
- 阶段3 文本链路打通：剧本分析端到端；补《填槽位提示词》《出图模板规范》《分镜契约》。
- 阶段4 图像：三视图(文生图) + 变体(图生图×四套前缀)。
- 阶段5 视频 + 分镜 + 资产自动匹配 + 画布同步 + 定时/批量容灾。

## 11. 代码地图（2026-06-21 全量复审实测，新会话定位用）

> 以下为**直接读码核对**的事实，覆盖 §10 中可能过时的口径。文件路径相对项目根。

### 11.1 用户端请求主链路（唯一路径）
```
表格按键 / 画布节点
  → runPurpose(purpose, input)              src/services/purposeRunner.ts
      ├─ PURPOSE_REGISTRY 取 capability/nodeType   src/lib/purposeRegistry.ts
      ├─ resolveAssetModelKey(cap) | 显式 modelKey  src/services/adapters/channelAdapter.ts
      ├─ getAdapter(modelKey)                       src/services/adapters/registry.ts
      ├─ ManagedAdapter.submit() → POST /v1/generate src/services/adapters/managedAdapter.ts + managedClient.ts
      └─ taskCenter.trackTask() 单例集中轮询         src/services/taskCenter.ts → taskTracker.ts
          └─ ManagedAdapter.poll() → GET /v1/tasks/{id}
```
- **画布节点**入口：`src/nodes/pluginRegistry.ts` 的 `defaultNodeExecute()`——resolveActiveModelKey→预检→`runPurpose(purpose,{modelKey,onProgress})`→落资产库+回写 resultAssetId。`nodeTaskTracker.ts` **已删**（§10 旧快照仍提它，实际不存在），画布与表格共用 `taskCenter` 单例。
- 轮询节奏：首轮 400ms、之后 2s；超时按能力——text 20min / video 15min / 其余 4min。5xx/网络抖动不立即判败，下轮重试。

### 11.2 用户端目录（实测文件，✅=已验证存在）
- `src/contract.ts`✅ — 两端共享协议类型。**Purpose 共 14 个**：script.toScenes, script.analyze, storyboard.split, **storyboard.toVideoPrompt**(第26轮新增), asset.{character|scene|creature|prop}.{image|variant}, video.generate, audio.tts。
- `src/lib/purposeRegistry.ts`✅ — 14 purpose 全映射；`unwiredPurposes()`=5（script.toScenes + scene/creature/prop variant + audio.tts）。
- `src/services/`：`managedClient.ts`(HTTP：login/heartbeat/fetchCatalog/generate/getTask/batch/uploadAsset/resolveAssetUrl) · `purposeRunner.ts`(runPurpose) · `taskCenter.ts`(单例分发) · `taskTracker.ts`(共享定时器) · `promptComposer.ts`(槽位合成 base/variant) · `modelAdapter.ts`(re-export) · `projectFile.ts`(+`.test.ts`) · `assetStore.ts` · `creditLedger.ts` · `fileStorage.ts` · `imageEditService.ts` · `projectZip.ts` · `scheduler.ts` · `taskBlackbox.ts` · `webdavSync.ts`。
- `src/services/adapters/`：`managedAdapter.ts`(catalog 模型→adapter，syncManagedAdapters) · `channelAdapter.ts`(模型解析助手，零兜底) · `registry.ts` · `types.ts` · `mockAdapter.ts`(离线 echo) · `index.ts`(只注册 mock) · `utils.ts`(printLLM*/truncateBase64)。
- `src/store/`：`connectionStore`(serverUrl+accessKey+session) · `catalogStore`(catalog 缓存+选择器) · `projectStore` · `settingsStore`(含休眠态 channels/apiKeys) · `uiStore` · `canvasStore`(节点/边/组+undo/redo) · `libraryStore`(软删) · `commitStore` · `assistantStore` · `history.ts` · `debouncedSave.ts`(+`.test.ts`)。
- `src/nodes/plugins/*.json`✅ — 9 个声明式插件(.js 已删)：text/script/image/video/audio + file_{image,video,audio,document}。

### 11.3 视图 ⇄ 路由 ⇄ 功能（实测 `src/router/routes.ts` + 视图内文案核对）
| 路由 | 视图 | 功能（已 grep 核对） |
|---|---|---|
| `/` | `Frame21` | 仪表盘/项目列表 |
| `/frame164` | `Frame164` | 新建项目（名/封面/画风） |
| `/frame1693` | `Frame1693` | 剧本编辑器（EditorSidebar 多 tab 总入口） |
| `/frame16285` | `Frame16285` | **角色**资产界面 |
| `/frame16550` | `Frame16550` | **场景**资产界面 |
| `/frame16780` | `Frame16780` | **生物**资产界面 |
| `/frame161000` | `Frame161000` | **物品/道具**资产界面 |
| `/frame161195` | `Frame161195` | **视频/分镜/故事板**界面（曾 1828 行占位，已重写为功能组件） |
| `/frame-storyboard` | `FrameStoryboard` | 独立故事板编辑器（**含 10 帧硬编码 mock + Unsplash 图**，待清理） |
| `/frame-canvas` | `FrameCanvas` | 画布节点编辑器 |
> 注：`src/views/Frame10902.tsx` 存在但**未在 routes 注册**（生物管理 Pixso 静态 mock，含九尾狐/九色鹿假数据）。§10 旧版本曾把 16550/16780/161000 的资产类型标错，以上为实测修正。

### 11.4 管理端（`server/`，Fastify+TS）
- **路由**：用户 API（Bearer accessKey）`POST /v1/login|heartbeat|generate|batch|assets`、`GET /v1/catalog|tasks/:id|batch/:id|assets/:id`、公开 `GET /v1/assets/:id/raw`、`GET /health`；管理 API（Bearer ADMIN_TOKEN）`/admin`(单页 HTML) + `/admin-api/{users,models,templates,logs}` CRUD。源码 `server/src/routes.ts`、`routes/admin.ts`。
- **协议派发** `translators/index.ts` `dispatchGenerate` 按 `model.protocol`：`echo`/`openai-chat`/`anthropic-messages`(文本，SSE 流式+部分正文+链式 runChain) · `openai-image`/`gemini-image`(图，真异步落资产) · `jianmeng-video`(视频，8s 轮询上游) · `stub`(占位)。上游解析 `upstream.ts`：默认 g-aisc 网关，jianmeng 走独立渠道；可按 protocol/模型字段覆盖 baseUrl/apiKey/upstreamModel。
- **持久化**：`server/data/` — `users.json`/`models.json`/`templates.json`(均带 version，变更自增→catalog `v{m}.t{t}` 热更) + `logs.jsonl`(append，上限 5000)。**任务与资产仍是内存 Map**（进程重启即丢，待 Postgres+S3）。资产 id `a{8位}` 单调永不复用。
- **计费**：`/generate` 与 `/batch` 前置校验余额(不足 402/记 failed)，受理/成功后按 `model.cost` 扣减，credits 经 heartbeat 回传客户端。
- **env**（`.env.example`）：`PORT`/`ADMIN_TOKEN`/`SEED_ACCESS_KEY`/`GATEWAY_BASE_URL`/`GATEWAY_API_KEY` + 可选 `{OPENAI,ANTHROPIC,GEMINI}_{BASE_URL,API_KEY}` + `JIANMENG_{BASE_URL,API_KEY}`。

### 11.5 已知遗留 / 待清理（实测）
- **未提交**：见顶部「版本控制现状」——本轮所有阶段1/2 成果尚未 commit。
- **mock/假数据**：`FrameStoryboard.tsx`(10 帧+Unsplash)、`Frame10902.tsx`(三只生物)、`Frame1693.tsx`(本地兜底画风文案)、`OperationPanel.tsx`(找不到模型时的 no-op fallback adapter)。
- **休眠字段**：`settingsStore.channels/apiKeys`、`projectFile.ts` 的 `table*/canvas*` 旧模型配置键（仅向后兼容读）。
- **未实现**：`registry.unregister()`（下架模型 adapter 不主动注销）；server 日志无过滤查询；链式仅两段（B 不再链）。

## 8. 变更记录

- 2026-06-21 第27轮（修复剧本分析"有结果但提取为0"）：根因——Frame1693 用旧 markdown 正则 `parseExtractedCharacters`(认 `人物X：名称`) 解析，而模型已返回 JSON；且 scenes/items/organisms 被硬编码为 `[]`。重写为 `parseAssetExtraction`：①`extractJsonObject` 花括号配平从散文里抠 JSON(容忍转义/代码块)；②按**编号前缀**分流 C/A/G→角色、S→场景、M→生物、P→物品(兼容扁平 `assets[]` 与嵌套 characters[]/...)；③变体(`C01A`/`inheritsFrom`)折叠进父资产 `variants[]`，孤儿变体兜底为独立基础资产不丢数据。删旧正则解析器。`资产拆分.md` 补「📤输出格式」段强制输出 `asset.extract.v1` 的 JSON(`assets[]`，`id` 遵编号法，`prompt` 承载整段出图模板)。**实测**：用户真实剧本→角色8/场景5/物品4/生物0；node 复现解析逻辑通过；tsc+build 过。**注意**：运行时提取实际产**扁平 `assets[]` 形态**(以提示词为准)，与 §4 锁定的嵌套 `asset.extract.v1` 是同一契约的两种排布，解析器两者都吃；当前 Frame1693 未传 schemaId(自由文本)，故 server 端 schema 仅备用。
- 2026-06-21 第26轮（输出契约锁定 + 提示词分目录转 md + 修正 purpose 计数）：① **修正第25轮回归**——实测 `script.toScenes` 仍在 `contract.ts`+`purposeRegistry.ts`，purpose 是 **13 个**不是 12（上轮正则漏了 `toScenes` 的大写 S）。② **提示词按流水线步骤分目录**：三份 Word 转 md——`小说2资产/资产拆分.md`(script.analyze)、`剧本2分镜/剧本划分分镜.md`(storyboard.split)、`分镜2视频/视频分镜提示词.md`(新 purpose)，删源 docx。③ **四项决策落契约**(整段模板/字段锁定/独立 purpose/保留公式)：契约 `Purpose` 加 `storyboard.toVideoPrompt`(共 14)，purposeRegistry 加映射(buttonLabel 生成视频提示词)；server catalog 三 schema 锁定——`asset.extract.v1`(整段模板版，每资产带 imagePrompt)、`storyboard.v1`(scriptContent+durationSec)、新 `videoPrompt.v1`(visualDescription 保留 {角色:}{场景:}{音频:} 公式)；templates 加 `storyboard.tovideo.basic` 默认模板。④ **§9 槽位拆分决策推翻**——改为 LLM 直接产整段出图模板，catalog imageTemplates + promptComposer 退居休眠。两端 tsc 干净、60 测试全过。**待办**：把 skills md 全文录入 DEFAULT_TEMPLATES body；server prompt.ts/dispatch 处理新 purpose；客户端 storyboard 界面接 toVideoPrompt + 正则抽公式自动填垫素材；parseShots 适配新 storyboard.v1(scriptContent)。
- 2026-06-21 第25轮（全量代码复审 + 文档校准）：不依赖旧文档、直接读码核对用户端 services/store/views/nodes + 管理端 server/ 全量，新增 §11 代码地图（请求主链路、目录实测、视图⇄路由⇄功能表、管理端端点/协议/持久化/计费/env、遗留清理）。**校正**：①资产视图映射修正(16285角色/16550场景/16780生物/161000物品/161195视频)；③`nodeTaskTracker.ts` 实已删除（旧快照仍提及），画布表格共用 `taskCenter` 单例；④`skills/` 旧 .md 已删、改为 `剧本2分镜/小说2资产/分镜2视频` 三份 .docx 草稿，运行时模板走 catalog。**实测质量**：客户端 tsc 干净 + 60 测试全过、server tsc 干净。**重点提示**：阶段1/2 全部改动尚未提交（untracked/deleted 未 commit），建议尽快固化。

- 2026-06-20 第24轮（图像/视频上游对接：g-aisc 图 + 简梦 JA 视频）：图像 `translateOpenAIImage` 改 g-aisc `/v1/images/generations`(response_format=url + 图生图 images[].image_url + 下载回字节落资产)。新增简梦视频协议 `jianmeng-video`：`jianmeng.ts`(submitJianmengVideo→POST /v1/videos 拿 task_id；pollJianmengVideo→GET /v1/videos/{id} 映射 queued/dispatched/running/completed/failed)；`createVideoPollingTask`(先回 taskId，后台提交+8s 轮询上游→completed 取 video_url 落任务，6h 链接，failed/20min 超时置败，进度随上游)。config 加 `jianmeng{baseUrl=api.jian1.vip, apiKey=JIANMENG_API_KEY}`；resolveUpstream 对 jianmeng-video 走独立渠道回退。models 加 7 个 JA 视频模型(fast/pro × 480/720 + 15s + 1080p，秒计费档可调时长/15s 档固定)+迁移补种；tasks 加 setTaskProgress；admin PROTOCOLS、.env.example 同步。server tsc + 冒烟(catalog 含 JA 模型；无 key 优雅失败"未配置上游密钥")过。**注意**：图生图/视频参考图需公网 HTTPS——本地生成图经 /raw 在 localhost 不可达，需部署到公网域名后真机验证；JA 用独立 sk-(JIANMENG_API_KEY)，与网关 key 不同。
- 2026-06-20 第23轮（文本上游 SSE 流式·保活+部分正文+进度）：server↔上游由"一次性阻塞(120s)"改为 SSE 流式，配合上一轮 client↔server 轮询，构成"上游流式保活 + 下游轮询抗断连"完整健壮组合。openai.ts `translateOpenAIText` 加 `stream:true` + 手解 SSE(data: 增量 choices[].delta.content)累积 + **空闲超时**(120s 无新数据才中断，总时长不限)；json 流式累积末尾整体 parse。anthropic.ts 改 `client.messages.stream`(on("text")累积 / 结构化用 finalMessage 取 tool_use)，客户端超时放宽 20min。tasks.ts 加 `partialText/partialProgress` + `appendTaskText`，getTaskState 对 running 任务回传部分正文+推进进度。index.ts 串 `OnDelta`：createTextTask 注入 `appendTaskText`，runTextSync/runChain 透传(A段中间不回传、B段最终回传)。server tsc + 冒烟(echo→async→poll success+partial)过。**已知缺口**：①管理端任务内存态，进程重启丢任务(待 Postgres 持久化)；②部分正文已到任务、客户端 UI 尚未展示(poll 仅成功回 resultUri)；③上游真实长任务联调待真 key。
- 2026-06-20 第22轮（长连接 async 基座·20w字抗断连）：文本生成由「同步内联返回」改为「异步任务+轮询」，根除浏览器/代理对长连接的时限掐断。server `dispatchGenerate`：文本协议(echo/openai-chat/anthropic-messages)走 `createTextTask`(createRunningTask→后台跑→completeTask/failTask，提交即回 taskId)；链式复合改 `runTextSync`(服务端内部同步)+`runChain`，对外仍异步；图像/桩不变。routes 无需改(已统一 async 处理)。客户端：taskCenter.trackTask + purposeRunner.awaitTask 加 `timeoutMs`，runPurpose 按能力放宽轮询超时(文本 20min/视频 15min/其余默认 4min)；managedClient.generate 已能吃 taskId、managedAdapter.poll 已把 result.text→resultUri，故透明。两端 tsc + 客户端 build + 服务端冒烟(echo 文本 dispatch→async taskId→poll success「回声」)全过。**决策**：输入小说/剧本由用户手动选；本工程先做长连接基座。**待办**：小说转剧本+剧本「第N集」确定性分集流程；资产提取结构化(槽位JSON)+提示词体系入库(资产拆分.md+zip 26 个→templates 分类/catalog 出图模板/变体前缀)；server→gateway 上游超时按长任务调优。
- 2026-06-20 第21轮（分镜不强制JSON + 故事板三方基座）：① 开始分镜去掉 schemaId 强制（上游不返合法 JSON 不再硬失败），parseShots 兼容 JSON + 文本两种。② 故事板生成接「图片素材 + 故事板提示词模板 + 分镜提示词」三方基座：Frame161195 加 `STORYBOARD_PROMPT_TEMPLATE`(占位，支持 `{{分镜提示词}}`) + `composeStoryboardPrompt`，handleStoryboard 把 shot.materials 图片作 input.images 传入图像模型；模板正文待用户提供后填入。③ 匹配素材确认用本地名匹配。tsc+build 过。
- 2026-06-20 第20轮（彻底去图片兜底 + 自动分集）：① 4 个资产界面(16285/16550/16780/161000)的 base `handleGenerateImage` 删除 Unsplash 图片 mock——no_model/失败/空返回一律报错，不塞假图；删除随之无用的 printLLM 导入。② 剧本提取自动产出分集：projectStore 加 `setEpisodes`；Frame1693 分析成功后追加一次文本模型调用(`runPurpose("script.analyze")` + 自定义分集 prompt)→`parseEpisodes`(JSON 优先)→`setEpisodes` 写入 episodes 供「视频」界面用；best-effort(失败仅 console.warn，不影响角色提取)；视频界面「新建分集」手动新增依旧保留。re-提取会覆盖自动分集。tsc+build 过。**遗留**：匹配素材仍本地名匹配(非 LLM)；故事板借用 asset.scene.image purpose。
- 2026-06-20 第19轮（视频/分镜界面接真功能）：Frame161195 从 1828 行静态占位重写为功能组件。数据模型加 `VideoEpisode/StoryboardShot/ShotMaterial`（projectFile + projectStore：episodes 状态 + addEpisode/updateEpisode/deleteEpisode/setEpisodeShots/updateShot + save/load/import/new 全链路持久化）。五功能接 runPurpose：①分集列表(左，store.episodes，可选/新建)；②开始分镜→`runPurpose("storyboard.split", schemaId storyboard.v1)`(文本模型)→`parseShots`(JSON 优先, 文本兜底解析, 解析不到报错不编造)→落 episode.shots；③匹配素材→本地确定性扫描资产名(角色/场景/生物/道具)填 materials + 提示词富文本 @胶囊(`.sb-mention`)；④故事板生成→`runPurpose("asset.scene.image")`(图像模型，复用 scene 图 purpose 作通用图生)；⑤视频生成→`runPurpose("video.generate")`(视频模型，带故事板图为输入)。素材缩略图：双击放大(单击关闭遮罩)/右键删除/+从资产库或本地上传。各动作 no_model/失败→报错不兜底。tsc+build 过。**遗留**：①剧本分析尚不产出 episodes（当前靠「新建分集」手动加+贴本集剧本，自动分集待接）；②匹配素材为本地名匹配（非 LLM 语义，按需可升级文本模型）；③故事板借用 asset.scene.image purpose（语义非专用，后续可加 storyboard.frame purpose）。
- 2026-06-20 第18轮（造型预设去占位·数据驱动变体）：4 个资产界面(角色/场景/生物/物品)的「造型预设」从硬编码 3 张占位卡（默认/战斗/日常、全景/特写/氛围、幼年/成年/化形、特写/使用/展示）改为按真实变体渲染——读 `asset.variants`，为空则显示「暂无造型预设（变体）」空态，不再造假卡。数据模型加 `AssetVariantLite{id,label,name,description,image?}` + 4 类资产 `variants?` 字段(projectFile + projectStore)。顺带删除 scene/creature/prop 三处 `handleGeneratePresetImage`（含其 Unsplash 预设图 mock，dead code）。tsc + build 全过。**遗留**：4 界面 base `handleGenerateImage` 仍含 Unsplash 兜底（待确认后清理）；变体的创建/提取流程未接（当前恒空态）。
- 2026-06-20 第17轮（去兜底·模型解析收敛 + 剧本提取去假数据）：① 模型解析层收敛为两层、零兜底——`channelAdapter.resolveActiveModelKey`=「节点自带 → 设置面板模型 → 否则 ""」；`resolveAssetModelKey`=「设置面板模型 → ""」（删 projectModelConfig 层 + 删 defaultMockModel 回退；resolveAssetModelKey 去掉第二参数，purposeRunner 同步）。modelKey 为空时 getAdapter 失败→ pluginRegistry/runPurpose 直接报错，绝不退回 mock。projectModelConfig 字段保留为旧项目惰性数据（不再参与解析）。② Frame1693 剧本分析删除全部假数据：删 `generateMockCharacters`、删硬编码 scenes(阎王殿)/items(青铜古剑)、删 mock 兜底分支；no_model/失败/空返回 → 直接报错并清零进度；场景/物品/生物当前提取提示词不产出 → 留空（待结构化提取接入）。分集数量硬编码 3 → 0。tsc + build 全过。**遗留**：4 个资产图界面(16285/16550/16780/161000) 仍有 Unsplash 图片 mock 兜底，待按同原则清理。
- 2026-06-20 第16轮（设置彻底合一）：资产/表格模式不再用精简版「项目模型配置」，改与画布模式共用同一个全局 `SettingsModal`（管理端/模型/生成偏好/WebDAV 四 tab）。EditorSidebar「设置」改开 `setSettingsOpen(true)`；删除 `ProjectSettingsModal.tsx` + App.tsx 渲染 + uiStore `projectSettingsOpen` 状态。projectModelConfig 解析层(channelAdapter)保留为旧项目惰性兜底（新建项目 UI 不再写入）。tsc + build 全过。
- 2026-06-20 第15轮（项目模型配置合一）：表格/画布单数据源双视图，模型配置同源——`ProjectSettingsModal` 删除「表格/资产模式」「画布模式」两套 UI，合并为单套「模型配置(表格/画布共用)」4 选择器。`projectFile.ts` 抽出 `ProjectModelConfig` 类型：统一键 `text/image/video/audio`，旧 `table*`/`canvas*` 标 @deprecated 仅兼容读取；projectStore 复用该类型。`channelAdapter` 两解析器(`resolveActiveModelKey`/`resolveAssetModelKey`)改 `统一键 ?? 旧键` 回退。两端 tsc + 客户端 build 全过。
- 2026-06-20 第14轮（提示词分类 + 附图 + 画风纳管）：模板系统扩展。`TemplateDef` 加 `category`(分类) + `images`(参考图 data URL[])，`purpose` 改可选（画风等"预设类"无 purpose、不可执行）；`tpl()`/`createTemplate`/admin POST 校验同步放宽。内置补 3 个画风预设(`style.3d-guoman/2d-hand/realistic`，category="画风"，body=视觉风格描述符)。catalog `buildTemplates` 下发 category/images，并对预设类(无 purpose)下发完整 body 供客户端取值。旧 `templates.json` 加迁移：补齐 category/images 字段 + 回填内置分类 + 补种缺失预设。契约 `CatalogTemplate` 加 category?/body?/images?，purpose 改可选。admin 控制台「提示词」tab：新增分类字段(datalist)+分类筛选下拉+purpose 可选(—预设/无)+每行「图片(n)」管理弹窗(上传压缩缩略图/预览/删除)。客户端 catalogStore 加 `templatesByCategory`/`artStyles`，`templatesByNode` 排除无 purpose 预设。新建项目页(Frame164)画风下拉改读 catalog 画风预设(无则本地兜底)，选中画风若带参考图则预览；visualStyle 取选中画风 body。底部三按钮(取消/进入资产模式/进入画布模式)修为同级同尺寸，两个"进入"按钮统一主色紧邻。两端 tsc + 客户端 build + catalog 冒烟(画风预设随 catalog 下发 v6.t9)全过。
- 2026-06-20 第13轮（新建项目页优化）：项目封面真实上传(canvas 压缩 512px webp 缩略图)+列表卡片展示；projectStore 加 `coverImage`(save/load/import/new 全链路 + recentProjects.cover)；QijiProject 加 coverImage。新建页精简为 名字/封面/画风 三项(删模型/比例/描述选择器)；右上角 X 修为可关闭；进出动画 slide→fade。
- 2026-06-20 第1轮：识别三套并存接入体系、凭证分裂、插件 config 空传等"接不上"根因。
- 2026-06-20 第2轮：确定网关架构（用户端→管理端→第三方）、声明式 JSON 插件、统一协议+结构化输出方向。
- 2026-06-20 第4轮：确认方案C、资产模型做满、变体=图生图（基础图+变体描述+保DNA默认前缀）、角色带音色字段、群像并入角色。导入第二批提示词(去重26个)并归类。产出《资产提取提示词 v0.1》含完整 JSON 契约。
- 2026-06-20 第5轮：确认槽位拆分（提取产槽位 + catalog出图模板合成）、变体前缀四类各一套。进入开发：定阶段计划、给后端技术栈/存储推荐、交付阶段0《qiji-contract.ts》共享契约。
- 2026-06-20 第6轮：确认技术栈(Node+TS+Fastify/S3/Postgres)。交付阶段1接入层(步骤A，纯加法)：connectionStore / managedClient / catalogStore / promptComposer / managedAdapter + App.tsx 改动说明。步骤B(删旧适配器+重写插件加载器+集中轮询)留下次。
- 2026-06-20 第8轮：决定管理端放同仓 `server/` 子目录、阶段2 第一刀=骨架+一真翻译器。交付 `server/` 骨架：Fastify+5端点+鉴权+内存存储+资产单调id序列+OpenAI兼容文本真翻译器(结构化输出强制)+echo联调模型+图/视频/音频占位。tsc 通过、curl 冒烟五端点全过。
- 2026-06-20 第7轮：交付阶段1步骤B。决定「本轮彻底切到 catalog」（模型选择/设置 UI 一并切换）。修正步骤A 误置的中文目录(服务/商店→services/store)。删 gvlm*/libImage/libAudio/seedance 5 适配器+catbox；channelAdapter 仅保留模型解析助手并改读 catalog；内置 9 节点 .js→声明式 .json，插件加载器去 JS 执行；新增 nodeTaskTracker 集中轮询；SettingsModal 渠道→管理端连接。tsc/构建/60 测试全过。
- 2026-06-20 第12轮（变体图生图·部分）：server 端变体提示词合成(buildPrompt 检测 asset.*.variant→catalog 变体前缀保DNA合成，catalog 加 getVariantPrefix；echo 验证)；Gemini 翻译器接底图(baseImagePart 从 req.inputs.images 取 server 资产字节作 inlineData→图生图)。两端 tsc 过。待办：客户端变体按钮接 runPurpose(传底图为 server 资产)+OpenAI images/edits。
- 2026-06-20 第11轮（额度按请求扣减）：users.ts 加 `chargeCredits(id,amount)`(足额则扣+持久化，返回 ok/remaining)；`/v1/generate` 前置校验余额不足→402 拒绝、不下单，dispatch 未失败(异步受理/同步成功)才扣 model.cost；credits 经 heartbeat 回传客户端。服务端 tsc + 冒烟(echo cost1：100000→99999；0额度用户→HTTP 402)过。`/batch` 同样逐任务校验+扣费(不足记 failed 任务跳过；冒烟 2任务→-2)。
- 2026-06-20 第10轮（管理端提示词管理·增量A）：模板数据化。决策：复合推理=链式两段(A输出喂B)、绑定=节点类型显式白名单。交付：`server/src/store/templates.ts`(TemplateDef 存 templates.json+CRUD+版本，含 body正文/nodeTypes白名单/chainNextId+chainPipeVar链式字段)；catalog 模板改 store 动态构建、版本并入 `v{model}.t{tpl}`；契约 CatalogTemplate 加 nodeTypes/isDefault；`prompt.ts.buildPrompt` 解析 templateId→正文+填{{变量}}(闭 TODO)；admin 路由+控制台加「提示词」tab(增删改/编辑正文/绑节点/设默认/链式 id)；客户端 catalogStore 加 templatesByNode/defaultTemplate。**增量B 链式复合已交付**：`dispatchGenerate` 加 `opts.noChain` + `runChain`——模板有 chainNextId 时先跑A(强制文本输出)→把输出注入B的 chainPipeVar 变量→跑B返回；仅文本→文本、限两段(B不再链)、防递归。两端 tsc+60测试+服务端冒烟(CRUD/版本bump/正文填充/链式 A产出注入B：`B收到[「回声」提取：小说内容]`)全过。**客户端节点选模板 UI 已接**：OperationPanel 加「提示词模板」胶囊(从 `templatesByNode(node.type)` 取，选中写 `params.templateId/purpose`)，`defaultNodeExecute` 透传 templateId 给 runPurpose→server 用权威正文(模板正文宜用 `{{prompt}}` 接收节点文本)。**余下精修**：VideoOperationPanel/表格 Frame1693 接 catalog 模板(现仍用本地 skills/*.md)、链式中间段日志、stage级 schema。
- 2026-06-20 第9轮（梳理工作流）：锁定「表格/画布=单数据源双视图」「树结构 小说/剧本→分集→分镜→垫素材(资产id引用)→视频，分集为第2级」「垫素材两端共有(选资产+上传)」「节点自带素材格子、连线为补充」「表格按键⇄画布节点一一映射」「资产项目级+分集按引用使用」「无映射资产入自定义类型兜底桶」。更新 §3/§5/§9。
