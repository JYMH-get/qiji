---
name: qiji-prompt-template-ops
description: Qiji 提示词模板/预设运维：管理端「提示词模板」「预设管理」页日常操作，新增内置模板/预设走补种，守住两条红线——SEED_VERSION/SKILL_REFRESH_VERSION 永不 bump、带 purpose 正文不下发。触发词：提示词模板、预设管理、内置模板、补种、模板泄露。
---

# Qiji 提示词模板 / 预设管理运维

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。下文所有相对路径均基于此。
> 本 skill 的存在意义：固化本项目最大的雷——**模板种子版本号永不再 bump**（详见「踩坑红线」第 1 条）。

## 何时使用

- 调优/新增/删除 提示词模板（带 purpose 的可执行推理模板）或 预设（画风/前后缀/宫格等）。
- 要往种子代码里加**内置**模板或内置预设（随部署首启入库）。
- 排查「客户端看不到模板正文」「模板正文疑似泄露」「模板被覆盖回旧正文」类问题。
- 任何人提议改 `templates.ts` 里的版本号常量时——先来读红线。

## 前置检查

1. **分清两条改动路径**（决定要不要部署）：
   - **数据层**：管理端 `/admin` →「提示词模板」/「预设管理」页，改的是 `server\data\templates.json` / `presets.json`。这是日常首选入口，**`data/templates.json` 是唯一权威**；改动经 catalog ≤30s 热更到客户端，**无需部署**。
   - **种子代码层**：`server\src\store\templates.ts` / `presets.ts`（内置条目随服务端首启入库），**须重新部署服务端**才生效。
2. **动种子代码前，先停本机 dev 的 tsx watch**（用 `qiji-dev-env-start` skill 的清杀流程）——tsx watch 会把编辑中间态热重启种进真实 dev 库（CLAUDE.md §9A 第216/217轮教训，modes/models/templates 同理）。
3. **核对版本号常量现值**（只读，不改）。Read `server\src\store\templates.ts` 第 99–121 行：
   - `SEED_VERSION = 2`（第 101 行）
   - `SKILL_REFRESH_VERSION = 4`（第 109 行；⚠ 警告注释在第 105–107 行，2026-07-19 用户定稿）
   - `RESET_VERSION = 1`（第 115 行）、`REMOVE_VERSION = 1`（第 120 行）、`REMOVE_IDS`（第 121 行）
   - 若发现数值比上面大，说明有人 bump 过——先查 `CLAUDE.md` §8 对应轮次再动手。

## 步骤

### A. 日常调优正文（首选，零代码）

管理端 `/admin`（Bearer ADMIN_TOKEN，dev 默认 `admin-dev`）→「提示词模板」页改可执行模板正文/分类/开放范围；画风、出图预设在独立的「预设管理」页。保存即落 `server\data\templates.json` / `presets.json`，客户端 ≤30s 热更，不需要部署、不需要碰任何 `.ts`。

### B. 新增内置模板（补种——唯一合法方式）

1. 编辑 `server\src\store\templates.ts` 的 `DEFAULT_TEMPLATES`，追加**新 id** 的条目（正文可内联字符串；`readSkill("xxx.md")` 只在首启种子时读入，之后一律在管理端维护）。
2. **不 bump 任何版本号**——补种机制"只加缺失、不动存量"，无需版本号（templates.ts 第 107 行注释原文）。
3. server tsc 核对：

   ```powershell
   # PowerShell 5.1（项目根下执行；勿用 && 连接命令）
   cd E:\Kaifa\Qiji\qiji\server; npx tsc --noEmit
   ```

4. 本机验证（见「验证」节）后，走 `qiji-pack-and-deploy-server` 部署；生产首启自动补种。
5. 若新模板带 `purpose`：正文/预览天然不下发客户端（预期行为），客户端只需 id 即可选用。

### C. 新增内置预设

`server\src\store\presets.ts` 的种子数组同规：**补种 + 墓碑（deletedSeedIds）**，同样没有任何需要 bump 的版本号。预设（无 purpose）正文会全文下发客户端（客户端要本地展开胶囊），与模板的保密语义相反——别搞混。

### D. 删除内置模板

- **首选**：管理端「提示词模板」页直接删——自动记 `deletedSeedIds` 墓碑（templates.ts 第 94–95 行），重启不会被补种复活。
- 代码路径（仅随发版批量删时用）：`REMOVE_IDS` 追加 id + `REMOVE_VERSION` +1（templates.ts 第 116–121 行）。这是**唯一**语义上允许 +1 的版本号：只删指定 id 并记墓碑，不触碰其余模板正文。

## 验证

1. **服务健康 + 新条目入库**（本机 dev 8787）：

   ```bash
   # Git Bash（curl 在 PS 5.1 是 Invoke-WebRequest 别名，勿在 PS 5.1 里照抄）
   curl -s http://localhost:8787/health
   grep -c "你的新模板id" server/data/templates.json   # 期望 ≥1
   ```

   ```powershell
   # PowerShell 5.1 等价
   Invoke-RestMethod http://localhost:8787/health
   Select-String -Path server\data\templates.json -Pattern "你的新模板id" | Measure-Object | Select-Object Count
   ```

2. **存量零改动 + 二启幂等**：改动前先备份 `templates.json`，补种重启后 diff 只多新条目；再重启一次，哈希零变化：

   ```powershell
   # PowerShell 5.1
   Get-FileHash server\data\templates.json -Algorithm MD5
   Get-FileHash server\data\presets.json -Algorithm MD5
   ```

3. **catalog 保密核验**（带 purpose 的模板 body/bodyPreview 均不得出现）。PS 5.1 下 `node -e` 内嵌双引号必挂，**先落临时脚本文件再执行**：

   ```powershell
   # PowerShell 5.1：写脚本文件（here-string 收尾 '@ 必须顶格）
   @'
   const r = await fetch("http://localhost:8787/v1/catalog", { headers: { Authorization: "Bearer dev-key" } });
   const c = await r.json();
   const bad = c.templates.filter(t => t.purpose && (t.body || t.bodyPreview));
   console.log(bad.length ? "泄露: " + bad.map(t => t.id).join(",") : "OK: 带 purpose 模板正文/预览均未下发");
   '@ | Set-Content -Encoding utf8 $env:TEMP\check-catalog.mjs
   node $env:TEMP\check-catalog.mjs
   ```

   （`dev-key` 是本机 dev 首启默认 accessKey；生产环境换真实用户密钥、地址换生产域。）

4. 影响面大（改了种子/迁移段）时：跑 `qiji-sandbox-smoke-test` 沙盒冒烟 + 二启幂等，再走部署。

## 踩坑红线

- ⚠ **永远不要再 bump `SEED_VERSION` / `SKILL_REFRESH_VERSION`**（`server\src\store\templates.ts` 第 101 / 109 行；第 105–107 行有同款警告注释，2026-07-19 用户定稿勿回退）——`server\skills\` 下的 md 已**全部过时**，bump 会用过时正文**覆盖用户在线上调好的模板**（SEED_VERSION=全量刷新、SKILL_REFRESH_VERSION=定向强刷 `SKILL_REFRESH_IDS` 五条）。新增内置模板只能走**补种**（只加缺失、不动存量），无需任何版本号。
- ⚠ **带 `purpose` 的模板 `body` 与 `bodyPreview` 都不下发 catalog**（`server\src\catalog.ts` 第 42–48 行统一规则；bodyPreview 曾经悬浮提示暴露正文开头，被用户判定为泄露后收口）。客户端"看不到正文"是保密设计不是 bug；改 catalog.ts 时严禁破坏此过滤。
- ⚠ `RESET_VERSION` 是一次性**裁剪**机制（bump 后启动把模板库裁剪为 `RESET_KEEP_IDS`，**删除其余全部含用户自建**，第 111–115 行）——已消费（v1），永不再 bump。
- ⚠ skills md（`server\skills\`，实测 8 个 md 分布于 分镜2视频/剧本2分镜/小说2资产 三个子目录）仅历史留档：**全新环境**首启种子会产出过时正文，部署新环境后需在管理端重调正文（CLAUDE.md §4 定稿）。
- ⚠ 提示词正文只在服务端：客户端只发 `templateId + variables`，绝不把正文写进客户端代码或 catalog 下发链路。
- ⚠ 动 `templates.ts` / `presets.ts` 种子代码前先停 dev tsx watch（编辑中间态会被热重启种进真实 dev 库；生产不受影响但 dev 库要人工修）。

## 相关文件

| 用途 | 路径 |
|---|---|
| 模板 store（种子/补种/墓碑/版本常量在第 99–121 行，实测约 30KB） | `server\src\store\templates.ts` |
| 预设 store（第174轮从模板库拆出；补种+墓碑，无 bump 雷） | `server\src\store\presets.ts` |
| catalog 下发过滤（purpose 模板正文/预览不下发，第 42–48 行） | `server\src\catalog.ts` |
| 模板数据（**唯一权威**，管理端改动落此） | `server\data\templates.json` |
| 预设数据 | `server\data\presets.json` |
| 提示词 md 原稿（**已全部过时**，仅历史留档） | `server\skills\` |
| 管理端单页（侧栏「提示词模板」「预设管理」页签） | `server\src\admin\index.html` |
| 管理 API（Bearer ADMIN_TOKEN） | `/admin-api/templates`、`/admin-api/presets` |
| 用户侧目录下发（保密核验入口） | `GET /v1/catalog` |

相关 skill：`qiji-dev-env-start`（清 tsx 僵尸/停服）、`qiji-sandbox-smoke-test`（种子改动冒烟）、`qiji-pack-and-deploy-server`（部署）。
