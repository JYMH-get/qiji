---
name: qiji-model-pricing-ops
description: Qiji 模型上架/定价/排序/开放范围运维：占位价转真价（小额真单对账后放开）、matLimits 素材上限、按渠道商分组开放、模式/家族排序启停。触发词：定真价、占位价、改模型价格、模型排序、开放范围、上架模型、素材上限。
---

# qiji-model-pricing-ops：模型上架 / 定价 / 排序 / 开放范围

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。正文路径均相对该根。
> 本 skill 覆盖的操作全部是**纯数据操作**（管理端 UI / admin API），改完经 catalog 热更 ≤30s 生效——
> **无需重新部署服务端、无需重新打包客户端**。要改 `models.ts` 种子/迁移代码则不属本 skill（走 qiji-add-upstream-channel）。

## 何时使用

- 接新渠道后把**占位价换成真价**（每次接渠道 CLAUDE.md 都留这条待办，本 skill 的核心流程）
- 调模型计费：按次 `cost` / 按秒 `costField`+`costPerUnit` / 按档 `routes` 覆盖价 / 参考视频系数 `refVideoSecondsWeight`
- 收素材上限 `matLimits`（如 933 → 903 = `vid:0` 禁垫视频）
- 设开放范围（按**渠道商分组**）、启停模型、调模型/模式/家族排序（影响客户端下拉）
- 不适用：接新渠道（qiji-add-upstream-channel）、部署（qiji-pack-and-deploy-server）

## 定价数据模型速览（本次已实测核对代码）

- **计费一把尺** `resolveModelCost`（`server/src/store/models.ts`，本次实测位于 1642 行起）：
  - 配了 `costField`（如视频 `duration`）→ 每单位价 = 命中路由的 `costPerUnit` ?? 模型 `costPerUnit`，金额 = round(每单位价 × 字段值)；
  - 否则固定价 = 命中路由的 `cost` ?? 模型 `cost`。
  - **P1 统一定价（第211轮）后 `planBilling` 调它不带 override**（`server/src/routes.ts` 实测）：价格恒平台价，渠道商换价/代调价已退役——预估 = 实扣 = 平台计费字段。
- **routes**：`when` 内每个键值与请求参数字符串相等即命中（`matchRoute`）；既可重定向上游真名，也可按档覆盖 `cost`/`costPerUnit`（如 480p/720p/1080p 各一价）。
- **兜底价规则（第134轮）**：按秒模型的 `cost` 是「字段缺失时的兜底价」，**默认按最高** = 每秒价 × 该模型最长时长。
- **refVideoSecondsWeight**（`server/src/refVideoBilling.ts`）：计费秒数 = duration + 系数 × Σceil(每条参考视频秒)，不足 1 秒算 1 秒；读不出时长**明确拒单**（勿改成静默按 0）。仅对配了 `costField` 的按秒模型生效。
- **catalog 版本串**（`server/src/catalog.ts` 实测）：`v{模型}.t{模板}[.p{定价}].m{模式}.f{家族}.ps{预设}`——渠道商归属用户才有 `.p` 段（承载改名/启停/换分组热更）；任一段变化 → 客户端 ≤30s 热更。
- **客户端下拉排序键**（catalog 实测）：模式 order → 模型 order → 原始加入序。**排序决定「自动取该能力第一个可用模型」的落点**。

## 前置检查

1. 服务端可达（Git Bash）：
   ```bash
   curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/health   # 生产换 <服务器地址>:8787
   ```
2. 拿 `ADMIN_TOKEN`（本机在 `server/.env`；生产在服务器环境配置）。
3. 确认操作对象是**数据**不是代码：改价/排序/开放范围一律走管理端 `/admin` 或 admin API。
   ⚠ 若确需改 `server/src/store/models.ts` 种子/迁移代码：**先停本机 dev tsx watch**（第216/217轮教训，见 qiji-dev-env-start），编辑完 tsc 过后再重启。

## 步骤

### A. 占位价 → 真价（核心流程）

1. **盘点占位价模型**：接入轮 CLAUDE.md 都标注「占位价，上线前管理端定真价」；`models.ts` 种子注释同样标注。列全量模型（Git Bash）：
   ```bash
   curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "http://localhost:8787/admin-api/models" > models.json
   ```
   PowerShell 5.1 等价：
   ```powershell
   Invoke-RestMethod -Headers @{Authorization="Bearer <ADMIN_TOKEN>"} "http://localhost:8787/admin-api/models" | ConvertTo-Json -Depth 6 | Out-File models.json -Encoding utf8
   ```
2. **小额真单**：用测试账号对该模型发一单**最小参数**（最短时长/最低分辨率档）。
   ⚠ 尤其按秒计费渠道、以及**上游按 GPU 时长计费**的渠道（如 autodl·ComfyUI 平台，第234轮：GPU 时长与出片秒数非线性）——不真单对账就定价必翻车。
3. **对账**：管理端「请求记录」取该单 logId/taskId →（Git Bash）
   ```bash
   curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "http://localhost:8787/admin-api/credit-ops?ref=<logId或taskId>"
   ```
   看逐笔 pre/post 余额（我方实扣），再到**上游后台**核对上游实扣，两边折算出真价。
4. **定真价**：管理端「模型」页卡片「设置」，或 API（Git Bash）：
   ```bash
   curl -s -X PUT "http://localhost:8787/admin-api/models/<模型id>" \
     -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
     -d '{"costPerUnit": 3, "cost": 45}'
   ```
   PowerShell 5.1 等价（JSON 用单引号字符串，防引号被剥）：
   ```powershell
   $body = '{"costPerUnit":3,"cost":45}'
   Invoke-RestMethod -Method Put -Uri "http://localhost:8787/admin-api/models/<模型id>" -Headers @{Authorization="Bearer <ADMIN_TOKEN>"} -ContentType "application/json" -Body $body
   ```
   多档价改 `routes`（整组替换）：`{"routes":[{"when":{"resolution":"1080p"},"upstreamModel":"...","costPerUnit":5}]}`。
   按秒模型同步把兜底 `cost` 按「每秒价 × 最长时长」改齐。
5. **放开**：确认 `enabled:true` + 设开放范围（见 C）。放开前真价必须已定——这是每轮接渠道的收口动作。

### B. 素材上限 matLimits

- 语义：键缺省 = 不限、`0` = 禁该类素材；例：933 收紧为 903 = `{"matLimits":{"img":9,"vid":0,"aud":3}}`。
- **只能收紧**（翻译器/上游能力表仍是最后一道闸）；generate/batch 服务端硬闸 + catalog 下发供客户端提交前预检。
- 走管理端「模型」卡「设置」或 `PUT /admin-api/models/<id>`（同 A4 写法）。

### C. 开放范围（按渠道商分组，第167/176轮）

- **按分组设置，不按具体商**：管理端「模型」卡面「开放范围」= 渠道商分组按键（源站/VIP/…）亮灭；全亮=all、全灭=none、部分亮=select+分组清单。分组本身在「渠道商」页管理。
- API：`PUT /admin-api/models/<id>`，body `{"shareScope":"select","shareGroupIds":["<分组id>"]}`；`{"shareScope":"all"}` 全开。
- select 判定按**归属链**：链上任一受众的生效分组命中即开放；要对个别商收窄用商级禁用清单（渠道商详情 blockedModels），任一级禁即禁。
- `hidden` 与开放范围独立：hidden 只控「不进客户端下拉」，仍可被调用计费。

### D. 排序（影响客户端下拉与「自动取第一个可用模型」落点）

- **模型**（同组内）：管理端「模型」页按住 ⠿ 拖动；API（须 ≥2 个 id，只置换这批的槽位、其余模型 order 不动）：
  ```bash
  curl -s -X POST "http://localhost:8787/admin-api/models/reorder" \
    -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" \
    -d '{"ids":["<排前的id>","<排后的id>"]}'
  ```
- **模式/家族**（排序+启停，第165轮）：管理端「渠道」页模式/家族卡片拖动与开关；API 同构：
  `POST /admin-api/modes/reorder`、`POST /admin-api/families/reorder`（body `{"ids":[...]}`，整表按 ids 重排）、`PUT /admin-api/modes/<id>` / `PUT /admin-api/families/<id>`（body 可带 `{"enabled":false}`）。
- 启停语义（catalog 实测）：**停用模式 = 其下模型整体不下发**（客户端隐藏，调用另有 403 兜底）；**停用家族 = 仅剥模型的 familyId**（客户端归「其他」，模型仍可用——家族是纯展示维度）。

### E. 备注 / 显示名

- `note`（第166轮）：`PUT /admin-api/models/<id>` body `{"note":"..."}`，客户端悬浮积分图标显示；空/null=清除（回落 matLimits 派生默认文案）。
- 渠道商改显示名走其门户（agentModelLabel，只动显示不动计费），源站侧无需操作。

## 验证

1. **catalog 版本变化 + 价格投影**（Git Bash，用任一用户 API 密钥）：
   ```bash
   curl -s -H "Authorization: Bearer <用户API密钥>" "http://localhost:8787/v1/catalog" | grep -o '"version":"[^"]*"'
   ```
   改动前后 version 串应变化；再 grep 该模型 id 确认 `cost`/`costPerUnit`/`costRules`（routes 档位投影）/`matLimits` 已是新值。
2. **客户端热更**：不重启客户端，≤30s 后模型下拉/预估价/下拉顺序应跟随（catalog 轮询热更）。
3. **实扣复核**：定完真价再发一单小额 → `GET /admin-api/credit-ops?ref=<新logId>` 确认实扣 = 新价（预估 = 实扣，P1 统一定价）。
4. 若改了开放范围：用目标分组内/外各一个商属账号拉 `/v1/catalog`，确认可见性符合预期（范围外调用应 403）。

## 踩坑红线

- ⚠ **占位价必须转真价再放开**：所有接入轮种子价都是占位价；按秒渠道与上游按 GPU 时长计费的渠道（autodl 等）**必须小额真单对账后定价**——CLAUDE.md 每轮接渠道都留此待办，本 skill 就是把它流程化。
- ⚠ **P1 统一定价勿回退（第211轮）**：价格恒平台价，`planBilling` 不带 override；渠道商换价/代调价整体退役。清单/旧文档里「渠道商定价覆盖」「代调价」均为过时描述，勿据此恢复任何定价链代码。
- ⚠ **开放范围按渠道商分组**（第167/176轮），非按具体商；旧 `shareAgentIds` 清单存量仍生效、新 UI 保存时会清空它。管理端语义：未动过分组按键且存量是旧清单 → 保存不带开放范围字段（绝不把存量语义抹成 none）。
- ⚠ **排序影响客户端**：模型 order 决定下拉顺序与「未选模型时自动取第一个可用模型」的落点——把最想让新用户默认用的排最前。`reorderModels` 只置换列出这批的槽位，**勿改成整表重排**（会把被筛掉的模型甩到末尾）。
- ⚠ **matLimits 只能收紧**；`matLimits`/`note`/`order` 是管理端自有配置，**不入 MODEL_REFRESH_FIELDS**（seed 刷新不冲掉）——放心在管理端改，接渠道的迁移不会覆盖。
- ⚠ **反面：真价字段（cost/costPerUnit/routes）恰在 MODEL_REFRESH_FIELDS 内**（`server\src\store\models.ts:1145`）——一旦 bump `MODELS_SEED_VERSION`，管理端定好的真价会被种子占位价整体冲回。接渠道一律走补种，勿 bump。
- ⚠ **hidden 内部计费模型（fee-thirdparty）勿归模式/家族**：归了模式 = 被禁该模式的用户连 LibTV/即梦手续费扣费都 403（代码里已强制剥除，勿绕过）。
- ⚠ **删内置模型走墓碑（deletedSeedIds）不复活**：勿为「恢复旧模型」清墓碑（第216轮惯例：重接用新 id）。
- ⚠ **服务运行中勿直接编辑 `server/data/models.json`**：models store 常驻内存、persist 时全量覆盖文件，手改会被回写丢失。一律走管理端/admin API。
- ⚠ **改种子/迁移代码前先停本机 tsx watch**（第216/217轮）：编辑中间态会被热重启种进真实 dev 库。纯管理端改价无此问题。
- ⚠ **`note` 会经 catalog 下发给用户**：勿写接入信息/上游线路等敏感内容。
- ⚠ **refVideoSecondsWeight 读不出参考视频时长 = 明确拒单**：静默按 0 = 漏收、瞎按上限 = 多收，报错优于编造（§9 零兜底）。
- ⚠ **计费冒烟纪律（第109轮事故）**：验证 402 预检类场景用小额码让预检拦截；只有「定真价对账」才允许小额真单真下发。
- ⚠ autodl 类工作流渠道：模型「上游模型名」= workflow_id，种子是占位符「请填写workflow_id」——上架前必须在管理端逐模型填真值（未填提交明确报错不扣费，第234轮）。

## 相关文件

| 用途 | 路径 |
|---|---|
| ModelDef / resolveModelCost / routes / matLimits / refVideoSecondsWeight / order / 墓碑 | `server/src/store/models.ts` |
| catalog 下发过滤 + 版本串 + 排序（客户端 ≤30s 热更） | `server/src/catalog.ts` |
| planBilling / chargeBilling（扣款在 dispatch 之前，无 override） | `server/src/routes.ts` |
| 参考视频按秒加权计费 | `server/src/refVideoBilling.ts` |
| 模式注册表（启停+排序，影响客户端下拉） | `server/src/store/modes.ts` |
| 家族注册表（启停+排序，纯展示分组） | `server/src/store/families.ts` |
| 渠道商分组 / 商级禁用清单 / 商改显示名 / 定价版本段 | `server/src/store/agents.ts` |
| admin API（models/modes/families CRUD+reorder、credit-ops） | `server/src/routes/admin.ts` |
| 管理端单页（「模型」「渠道」「收藏与配额」等页面） | `server/src/admin/index.html` |
| 素材上限硬闸 | `server/src/materialLimits.ts` |
| 客户端预估价单一来源（与服务端一把尺对齐） | `src/lib/genParams.ts` |
| 运行时数据（勿在服务运行中手改） | `server/data/models.json`、`modes.json`、`families.json` |
