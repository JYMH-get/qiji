# 渠道模型更新 · 情报源全表

> 每渠道一条：**情报源（怎么拉最新清单）→ 种子工厂 → 更新史 → 更新要点（坑）**。
> 行号会漂移——定位一律按 **工厂名/常量名 grep**（`server\src\store\models.ts` 与各翻译器）。
> 全表按「有无自助情报端点」分两组；接新渠道后**在对应组增补一行**（SKILL.md「后续接新渠道」节的义务）。
> 各端点存活状态标注了最近一次实测日期——隔久了先重新 curl 一遍再信。

## 一、有自助情报端点（一条命令拉到最新清单）

### congge（聪宸，congchen.top）— 模式 congge · ch-congge · congge.ts

- **情报源**：`curl -s https://congchen.top/api/pricing`（**免鉴权**，New API 模型广场数据源；2026-08-17 实测 200/31 款）。`/v1/models` 需 Bearer（无 Key 401）。
- **丰富度**：全量——每行 `model_name` + `description`（内含 **调用模型ID**/元价/时长范围/素材上限「9 图 / 3 视频 / 3 音频」/是否过真人）+ `quota_type`（0=按量 tokens、1=按次/条/秒）+ `model_price`（元）+ `enable_groups`。
- ⚠ **展示名与技术 ID 成对出现**（「谷歌 Veo 3.1 Fast 快速版」与「veo-3.1-fast」同款，技术 ID 行标「大厅隐藏，调用仍可用」）——diff 前按 description 里的「调用模型ID」去重。
- **种子工厂**：`cgImg()`（图）+ `cgVid()`（视频，routes 承载「分辨率→上游真名+档价」）。
- **更新史**：第233轮接入（图3+视4 外显，视频 routes 重定向 9 个上游真名）。
- **要点**：①上游视频名**带空格且大小写敏感**、同系不同款空格还不一致（2026-08-17 广场实锤：`seedance 2.0 903 Fast-480p` 有空格、`seedance 2.0 903Fast-720p` 无空格）——每条单独照抄；②能力守卫按 `capsOf` 前缀（seedance2.5→30/10/10·30s，seedance2.0→9/3/3·15s，未知名不守卫直发）——同前缀新档管理端建模型即接；③折算尺：视频≈按 720p 锚点折积分/秒（第233轮 用户定 mini30/fast40/2.0-50/2.5-60），图片按次；④图片侧勿发 size、视频侧勿发 size/resolution（第233轮 §9A）。

### 简梦Z（zexitongxue.com）— 模式 jmz · ch-jmz · jmz.ts

- **情报源**：`curl -s "https://zexitongxue.com/ai-api/models?type=video"` 与 `?type=image`（**免鉴权**；2026-08-17 实测双 200）。第152轮明记「**后续维护先做这一步**」。
- **丰富度**：全量——逐模型 note/duration_profile/duration_rules/resolution_profile/max_reference_images/can_use；图片目录另带价与图上限。**比文档正文细且新**（豆包线首尾帧：文档说不支持、目录 note 明示已支持——以目录为准）。
- **种子工厂**：`jmz()`（视频）+ `jmzImg()`（图片）。
- **更新史**：第152轮视频 14 款接入、第153轮图片 7 款并入（grok 三款不在目录但文档「有效生图模型」表列有效——目录与文档取并集）；此后未更新。
- **要点**：①能力表两张：视频 `CAPS` + 图片 `IMG_CAPS`（jmz.ts），按目录维护——目录未注明的能力=undefined 不本地拦、明确写不支持的才 0；②结果链接非公开：下载带 Bearer（resultHeaders 仅本站域）、图片结果约 2h 失效；③GPT Image 2 的 2K/4K 能力由 **Key 所在分组**决定（站方控制台配「image2 4k」），我方不传线路信息；④只公布 success 一种终态→防御式状态族。

### Skylee（api.808relay.com）— 模式 skylee · ch-skylee · relay808.ts

- **情报源**：`curl -s https://api.808relay.com/llms.txt`（**免鉴权**静态文本；2026-08-17 实测 200/26KB）。含每模型**推荐接入端点**（接口归属以 llms.txt 为准——站点章节标签有错，第230轮实锤）。
- **丰富度**：清单+推荐端点+站点价目（元/次，含 `[zz]` 廉价平行线与 MJ 四档账号价）；无状态词枚举、无逐模型图上限。
- **种子工厂**：`sky()`；款式形态表 `KIND`（relay808.ts，gpt/gemini/mj 三形态）。
- **更新史**：第230轮接入 12 款；此后未更新。
- **要点**：①KIND 键与站点名**逐字一致**（`[zz]` 方括号、`[zz] gemini-3.1-flash-lite-image` 的 `[zz]` 后有一个空格）；②更新=重拉 llms.txt 对照 KIND 与 sky() 种子；③折算尺≈元/次×100；④主线异常备用入口 api2.808relay.com 参数全同；⑤MJ 一次返四图但管线只落 data[0]（已知边界）。

### 星辰（AIStartLab）— 模式 xingchen · ch-aistars · aistars.ts

- **情报源**：`curl -s -H "Authorization: Bearer $KEY" https://api.video.aistarslab.com/openapi/generation/config`（**需渠道密钥** sk_；渠道 baseUrl 已含 /openapi）。另有官方测试线 `channel=test / model=test-video|test-image` 零扣费可全链路联调。
- **丰富度**：**全渠道最富**——逐线路×模型×质量档：素材上限/时长档/比例/frames 支持/needImage/上游积分价。历轮全靠它。
- **种子工厂**：`ais()`（视频）+ `aisImg()`（图片）；能力守卫表 `LINES`/`IMG_LINES`（aistars.ts）。
- **更新史**：第132轮接入 14 款 → 第148轮 config 换线 14→6（xcRefreshVersion，重写式）→ 第162轮 +6（xc50RenameVersion 改名雷）→ 第216轮「全部接上」12→24（xcCaps216Version **守卫式**：只改仍为旧种子形状的字段，管理端改过的分毫不动——存量迁移的标准定式）。
- **要点**：①upstreamModel 编码 `channel|model|quality` 三段——同模型横跨多线不唯一，线路必须钉在定义/routes 勿动态反查；②config 更新时同步重写 LINES/IMG_LINES（第215轮起 aspects/时长仅作缺省默认，img/vid/aud/needImage/frames 仍是前置守卫）；③换线一律新 id（第216轮 xc600-gemini-omni 先例）、防撞墓碑（第162轮 fast-c 雷）；④新家族 classifyFamily 规则必须排在 seedance 数字兜底正则 `/933|431|403|900|903/` **之前**（xc903-minimax 会被误吞）；⑤含参考视频上游积分 ×1.5。

### 苏打水/简梦S（api.sudashuiapi.com）— 模式 jms · ch-sudashui · sudashui.ts

- **情报源**：`curl -s -H "Authorization: Bearer $KEY" https://api.sudashuiapi.com/v1/models`（**需渠道密钥**）。
- **丰富度**：⚠ **仅模型 id、零能力元数据**（第131/149轮两次实锤）——新线能力只能按命名推断，实锤后再补守卫（第149轮定式：能力未知不守卫、上游兜底）。
- **种子工厂**：`sds()`。
- **更新史**：第131轮 16 款 → 第149轮按 /v1/models 全量更新 16→26（sdsRefreshVersion：死链墓碑+只补缺+新线补种）→ 第156轮收编 26→7 合一为简梦S（sdsConsolidateVersion）→ 第215轮根除 hn 线就近取档夹钳。
- **要点**：①代码里现存的前缀守卫**只有** `/^sdas-gf-/`（官方真人线拒参考视频；`sdas-gf2-` 有意不命中勿收紧）——hn 线 5/10/15 三档是**管理端参数档**不是翻译器守卫（第215轮后 duration 原样透传，sudashui.ts 头注释里的旧说法已过时）；②提示词引用是**小写** @image1；③metadata.payload 是 JSON 字符串非对象；④提交扁平小写 vs 轮询 {code,data} 大写双形状；⑤失败时 result_url 可能塞错误文案——必须验 http(s)。

### 画影（AI-Studio aixyzz）— 模式 huaying · ch-huaying · huaying.ts

- **情报源**：`curl -s -H "Authorization: Bearer $KEY" https://ai-studio.aixyzz.com/v1/models`（**需渠道密钥** lv_；渠道 baseUrl 已含 /v1）。
- **丰富度**：mediaLimits（素材上限）/分辨率/比例可信；⚠ `inputModes` 恒 ["text"] **不可信**（第133轮实锤，以 mediaLimits 为准）。
- **种子工厂**：`hy()`；能力表 `CAPS`（huaying.ts）。
- **更新史**：第133轮接入 6 款；此后未更新。
- **要点**：①真机与文档三处出入勿按文档回退（第133轮）：firstFrame/lastFrame 全线拒收（无首尾帧）、请求体严格 schema 未知字段 invalid_json、inputModes 不可信；②requestId 幂等用 clientTaskId（防重复扣费）；③创建即预扣（balance.reserved）。

### 算力（xienlive.com · OctopusAI）— 模式 suanli · ch-suanli · suanli.ts

- **情报源**：xienlive.com 官方 **api.html 公开文档页内嵌 spec**（免鉴权；第217轮据此实拉三端点全形状）；价目无自助端点、靠用户价目表（含视频参考折扣双维度，我方保守按无视频档）。
- **种子工厂**：无（models.ts 内 def() 直写单模型 `sl933-minimax-h3`；4 档分辨率是普通请求参数，routes 只换价不换上游名）。
- **更新史**：第217轮接入；第231轮 +`up_resolution:"off"`（用户转发上游新文档）。
- **要点**：①素材引用=`<<<N>>>` **0 基全局下标**（materials 混排，图→视→音），转写走 `suanliTags` 单点；追加素材只能追加 materials **末尾**；②up_resolution 缺省恒发 "off"、显式原样透传（勿写死）；③参考音频须伴随图或视频（守卫勿删）；④20 态 statusText「生成中 62.5% (5/8)」提取进度。

### LibTV（本地 CLI）— 功能模式 features.libtv · src/services/libtvCli.ts + adapters/libtvAdapter.ts

- **情报源**：真机 CLI：`libtv model search --type video`（线上清单，返回 modelKey/modelName）→ `libtv model <modelKey>`（逐模型全量 schema：分辨率/时长/比例/设置键）→ `libtv --version`。**需本机 LibTV 账号已登录**。
- **更新史**：第94轮接入 → 第107轮 +Fast → 第203轮 +MiniMax H3（CLI 1.1.1 已最新；H3 schema 无 enableSound 键→按变体分发）。
- **要点**：①加款改两处：`LIBTV_MODEL_CHOICES`（libtvAdapter）+ `SEEDANCE_VARIANTS`（libtvCli）；②**永远按 modelKey 定位**（线上显示名会漂，第94轮规则）；③enableSound 仅 Seedance 系 schema 有，勿恒发；④家族 id 客户端自带（如 fam-minimax），服务端注册同 id 家族显示名自动跟随；⑤属客户端改动**须重新打包**——完整流程见 skill `qiji-local-cli-upgrade`。

### 即梦 Dreamina（本地 CLI）— 功能模式 features.dreamina · src/services/dreaminaCli.ts + adapters/dreaminaAdapter.ts

- **情报源**：`curl -s https://lf3-static.bytednsdoc.com/obj/eden-cn/psj_hupthlyk/ljhwZthlaukjlkulzlp/dreamina_cli_beta/version.json`（**免鉴权**公网直链，只给版本号+日期）；新版档位靠升级后 `dreamina --version` + `dreamina multimodal2video -h` 实证（第203轮以此发现 1.4.15 新增 seedance2.5）。升级=删旧 exe 重跑 `src-tauri/scripts/fetch-dreamina.ps1`。
- **更新史**：第107轮接入（内置 1.4.10 四款）→ 第203轮升 1.4.15 +seedance2.5（VIP 专属，4-30s/图30视10音10/允许纯音频）+2.0mini。
- **要点**：①加款只改 `DREAMINA_MODEL_CHOICES` 一处；②夹钳分界（第203轮定稿勿动）：存量四款保留 clampDreamina* 收敛，**新款一律 §9 原样透传**；③1.4.15 起 --video_resolution 必填+参数严格校验；④部分模型首用可能返 AigcComplianceConfirmationRequired（需先在即梦 Web 端用该模型出过一次图）；⑤客户端改动**须重新打包**——见 skill `qiji-local-cli-upgrade`。

## 二、无自助端点（更新靠用户提供文档 / 控制台人工查）

### 简梦JA（api.jian1.vip → 生产实际 api.nyxen.sbs）— 模式 qiji · ch-jianmeng · jianmeng.ts

- 无清单端点；接入以来稳定 2 款（seedance-2.0/-fast，routes 重定向 JA-sd2-* 真名）。渠道 baseUrl 以**管理端当前配置为准**（种子与生产已不同）。
- ⚠ **jianmeng.ts 是全体视频翻译器的共享基座**（VideoSubmit/VideoPoll/resolveNamed/injectReferenceTags 十几家 import）——更新该渠道时勿顺手改共享导出。上游成片仅 6h 有效（转存 OSS 兜底）。

### 简梦P（Base 由管理端配）— 模式 jmp · ch-jianmengp · jianmengp.ts

- 靠用户文档（第159轮版名 pixelhub_video.md，含 Supported Models 清单 + Model Capability Matrix）；⚠ 文档连 Base URL 都不给。
- 更新定式=第159轮「文档里没有了就删掉」：新增补种（+gemini-omni-flash）、下架墓碑（jmpTrimVersion 删 veo31/veo31-ref）。CAPS 表两种下架待遇：veo31 留守卫（管理端可重建）、veo31-ref 连条目删。工厂 `jmp()`。

### 简梦M（MuseAI museai.vip）— 模式 jmm · ch-musem · musem.ts

- 靠用户文档（OpenAPI 两份+「可用模型列表」表）。工厂 `jmm()`；能力表 `CAPS`（K 线图4音3视0 / HU 线图9视3音3）。
- ⚠ 鉴权是 `apikey: MUSE-...` 头**不是 Bearer**；真 @tag 引用（images/audios/videos 逐条 {tag,url}）；images 是 schema 必填恒发（空数组也发）；任务号 data 是数字转字符串。

### 简梦H（ZhengAPI zhengapi.top）— 模式 jmh · ch-jmh · jmh.ts

- 靠用户文档；⚠ 新旧文档矛盾时以**新统一文档**为准（第155轮裁决勿回退）。工厂 `jmh()`（图）+ `jmhVid()`（视频）。
- **模型 ID 现拼**是该家最大坑：图片 firefly 拼 `-{1k|2k|4k}-{比例}`（FIREFLY_RATIOS）、视频按家族拼时长/比例/分辨率（VID_CAPS：grok 朝向由比例定、sora2 不发 resolution、kling3 恒 15s）——**上游调档=改这两张表或管理端加档，多数零代码**。grok 图片 image=单值纯 base64 无 data: 前缀（与 firefly 相反）。

### 简梦T（llm.chre3.com · 单模型 sd2-c8）— 模式 jmt · ch-jmt · jmt.ts

- 单模型站，靠用户文档。def() 直写 `jmt933-sd2.0`。
- @Image1/@Video1/@Audio1 原生占位符与我方图例**直通零转写**；compliance_mode 白名单外不发；720p 固定只发 aspect_ratio。

### 简梦F（new.vosle.xyz）— 模式 jmf · ch-jmf · jmf.ts

- 靠用户文档，但**模型 ID 现拼**（基名 `seedance-2.0` + 比例+分辨率+时长）→ 上游放开新档（如 1080p）**不用等文档：管理端给 resolution 加档即放行**；管理端自建含 "+" 的完整 ID 原样直发。def() 直写。
- ⚠ 成片下载须带同一 Key 且 24h 时效（resultHeaders 仅本站域）——必须配好 OSS。

### Dimensio（jimeng.dimensio.cn）— 模式 dimensio · ch-dimensio · dimensio.ts

- 靠用户文档（「视频接口规格」的「当前开放模型」章节）。工厂 `dm()`；能力表 `CAPS`（res 档首位**仅作缺省默认**——第215轮已根除越档回退，dimensio.ts 旧字段注释里的「回退值」说法过时）。
- functionMode 三态映射勿改（frames→first_last_frames、有素材→omni_reference、纯文生→first_last_frames）；200 也可能带 {code,message}，task_id 才是提交成功判据；参考视频按秒计费 refVideoSecondsWeight=1（第143轮）。

### Aivide（aivideo.beauty · 单模型）— 模式 aivide · ch-aivide · aivide.ts

- 靠用户文档（v2.0，2026-07-17）。def() 直写 `av933-2.0` 系（dev 库曾有款被管理端删除进墓碑——**不复活不复用 id**）。
- 素材=图≤9、**视+音合计≤3**（区别于各自 3）；提交不幂等勿加重试；失败响应里的非空 video_url 不得当结果；轮询 12s。

### 出海营（api.aiid.edu.kg）— 模式 overseas · ch-overseas · overseas.ts

- 靠用户文档（docs/overseas-seedanceAPI文档.txt）。工厂 `os()`；分辨率档经 routes 重定向上游后缀款（对照 `doubao-seedance-2-0-260128` 类带版本号上游名，版本号段变更即换代）。
- 更新史：第186轮接入 → 第187轮 osSd25DurVersion（2.5 时长 15→30，**守卫式迁移的教科书**：用户已定真价 cost 1875 分毫未动）→ 第188轮时长透传定稿为 §9 全局规则。价格：上游从未公布；os933-sd2.5 已定真价、其余 4 款仍占位。
- 素材走 content 数组混排（name=ImageN 与 @tag 图例一一对应勿动排序）；查询双形态防御。

### Yali（api.yaliai.com）— 模式 yali · ch-yali-openai + ch-yali-gemini · yali.ts

- 情报=官方 **/docs SPA 浏览器逐页读取**（纯 HTTP 抓不到正文；文档公开免 Key）。工厂 `yali()`。
- ⚠ 一把 Key 绑一种接口类型（OpenAI Images / Banana·Gemini），新增模型须归对渠道；quality 仅 OpenAI 类发；512/0.5k 档走 OpenAI Images 形态表达不了（不开）。

### 云雾（yunwu.ai）— 模式 yunwu · ch-yunwu · 复用 openai-chat

- **设计上就不走种子**：聚合站模型众多，加模型=管理端新建（协议 openai-chat、渠道「云雾」、上游名照抄站内名），零代码零部署。清单=站内模型市场人工查（理论上有 /v1/models 但从未验证，不可当已确认端点）。
- ⚠ 密钥必须在管理端渠道填（无独立环境变量，留空会把网关密钥错发 yunwu.ai 得 401）；-thinking 系 reasoning_content 天然兼容。

### 火山 MediaKit — 无模式 · ch-volc-mediakit · volc.ts

- 无清单端点：工具端点是**固定路径**——5 个视频工具走异步 `POST /api/v1/tools/{tool}` + `GET /api/v1/tasks/{task_id}`（enhance-video-generative/-fast/enhance-video:standard|:professional/erase-video-subtitle-pro）；⚠ 图像超分 `enhance-image` 走**同步** `POST /api/v1/tools-sync/enhance-image`（无 task_id 无查询）。情报靠火山官方产品文档。
- 加档/改档全在管理端「模型→参数」即生效零代码；⚠ `clampEnum` 是按管理端实时参数收敛的**防费用失控硬闸**（第122轮定稿、第215轮明确保留）——不是夹钳勿删；参数白名单：5 视频工具走 TOOL_PARAM_KEYS 常量、enhance-image 是 volc.ts 内独立清单。上游 video_url 仅 24h（rehost 兜底）。

### autodl（autodl.art · ComfyUI 工作流）— 模式 autodl · ch-autodl · autodl.ts

- **模型清单本质=用户在 autodl 控制台开了哪些工作流**，无平台级清单端点：workflow_id 与入参在控制台「工作流」页自查（右侧抽屉看入参）；官方 docs/comfyui_api 公开。工厂 `adl()`。
- ⚠ **workflow_id 即上游模型名**（一个工作流=一个模型）——「加新模型」=控制台拿 workflow_id → 管理端建模型填入即接，零代码；占位符「请填写workflow_id」/回退 `^adl-` 形态前置报错不扣费。
- 鉴权 `Authorization: <Token>` **原样不带 Bearer**；duration/resolution（中文档位串如「768p竖」）缺省不发、显式原样透传；未公布失败状态词（防御式状态族）；ComfyUI 可能按 GPU 时长计费与秒数非线性——**先小额真单对账再定真价**；errorScrub「域名隐藏在模式名保护之前」的顺序为 autodl 而定（第234轮）勿回退。
