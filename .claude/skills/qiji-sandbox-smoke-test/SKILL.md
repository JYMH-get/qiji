---
name: qiji-sandbox-smoke-test
description: 在隔离沙盒中对 Qiji 服务端跑冒烟测试：镜像目录 + junction node_modules + 独立 data，stub fetch 零真实上游调用、真实开发库零触碰。接新渠道、改种子/迁移/计费逻辑、部署服务端前必跑。触发词：沙盒冒烟、二启幂等、接新渠道、部署前验证。
---

# Qiji 隔离沙盒冒烟测试

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。
> 下文所有路径均相对项目根；命令中用 `$ROOT` 代指项目根绝对路径。

核心口诀（CLAUDE.md 历轮定式）：**复制 src + junction node_modules + 独立 data，stub fetch 零真实上游调用，真实库零触碰**。

## 何时使用

- 接入新上游渠道后（新翻译器 / 新协议 / 新模式 / 模型种子）——每轮接渠道的标准动作。
- 改动 `server\src\store\` 下任何**种子 / 启动迁移 / 补种 / 墓碑**逻辑（models/modes/channels/families/templates/users/agents）。
- 改动计费（planBilling/chargeBilling/settle）、errorScrub、日志、保留策略等服务端热路径。
- **部署服务端之前**——单轮迭代节奏固定为：改代码 → 全套自检 → 沙盒冒烟 → 更新 CLAUDE.md → 部署。
- 需要验证「二次启动幂等」（迁移/补种代码跑两遍 data 文件零变化）。

## 前置检查

1. `server\node_modules` 存在（缺则先在 `server` 目录 `npm i`；tsx 是 devDependency，运行时必需）。
2. 确认真实开发库位置与体量，**这是绝不能被冒烟污染的对象**：
   `server\data\`（models.json ≈160KB / channels.json / modes.json / qiji.db ≈17MB 等）。
3. 想清楚 data 场景：**全新空库**（测首启种子/全新环境）还是**真实库副本**（测存量迁移/补种守卫）。
4. 若沙盒里要起完整服务：选一个不冲突的端口（本机 dev 常占 8787，历轮沙盒惯用 8917/8967/8968）。

## 步骤

沙盒目录在**当前会话 scratchpad 或 `%TEMP%` 下新建**，不要写死路径（其他设备不同）。

### 1. 建沙盒（镜像仓库两层结构）——本机 PowerShell 5.1（不支持 `&&`，逐行执行）

⚠ 沙盒必须镜像「仓库根/server」两层结构：`server\src\contract.ts` 的内容是
`export * from "../../src/contract"`，只复制 `server\src` 平铺到沙盒根会断 import。
根 `src\contract.ts` 是零依赖单文件，复制这一个文件即可。

```powershell
$ROOT = "E:\Kaifa\Qiji\qiji"                      # 其他设备改为实际 clone 位置
$SB = Join-Path $env:TEMP ("qiji-sbx-" + (Get-Date -Format "MMdd-HHmm"))
New-Item -ItemType Directory -Force "$SB\src" | Out-Null
New-Item -ItemType Directory -Force "$SB\server" | Out-Null

Copy-Item "$ROOT\src\contract.ts" "$SB\src\contract.ts"
Copy-Item "$ROOT\server\src" "$SB\server\src" -Recurse
Copy-Item "$ROOT\server\skills" "$SB\server\skills" -Recurse
```

### 2. junction node_modules（不是复制——实测近万个文件，junction 秒级完成且与真实依赖保持同步）

PowerShell 5.1：

```powershell
New-Item -ItemType Junction -Path "$SB\server\node_modules" -Target "$ROOT\server\node_modules" | Out-Null
```

或 cmd（等价写法；`<沙盒路径>` 手动替换为上一步 `$SB` 的实际值——cmd 不会展开 PowerShell 变量）：

```cmd
mklink /J "<沙盒路径>\server\node_modules" "E:\Kaifa\Qiji\qiji\server\node_modules"
```

### 3. 准备独立 data

DATA_DIR 由 `server\src\store\db.ts` 用**模块相对路径**推导（`import.meta.url` 上溯
`../../data`），所以沙盒里的代码天然落 `$SB\server\data`，零配置即与真实库隔离。
同理 `server\src\config.ts` 的 loadDotEnv 只读 `$SB\server\.env`——**不要复制真实
.env**，沙盒无密钥 = 即使 stub 漏了也发不出带真实凭据的请求。

- 场景 A · 全新空库：什么都不用建，启动时自动 mkdir + 种子入库。
- 场景 B · 存量迁移（PowerShell 5.1）：

```powershell
New-Item -ItemType Directory -Force "$SB\server\data" | Out-Null
Copy-Item "$ROOT\server\data\models.json","$ROOT\server\data\modes.json","$ROOT\server\data\channels.json","$ROOT\server\data\families.json" "$SB\server\data\"
# 需要资产台账/日志表时再补：Copy-Item "$ROOT\server\data\qiji.db" "$SB\server\data\"
```

### 4. 写冒烟脚本（stub fetch + import 模块跑断言）

脚本放 `$SB\server\smoke.mjs`。骨架（历轮定式）：

```js
// smoke.mjs —— 断言分组统计，结论形如 54/54
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error("FAIL:", name); } };

// ① stub 全局 fetch —— 必须在 import 任何业务模块之前
globalThis.fetch = async (url, init) => {
  // 按用例伪造上游回执；未覆盖的一律抛错，保证零真实上游调用
  throw new Error("沙盒禁止真实网络请求: " + url);
};

// ② 动态 import 沙盒模块（tsx 直跑 .ts）
const models = await import("./src/store/models.ts");
ok(models.listModels?.().length > 0, "种子入库");
// …… 按本轮改动补断言：catalog 不泄漏上游真名 / submit body 形状 / poll 各状态 / errorScrub 品牌词

console.log(`${pass}/${pass + fail}`);
process.exitCode = fail ? 1 : 0;   // ⚠ 勿用 process.exit()，见踩坑红线
```

运行（本机 PowerShell 5.1 或 Git Bash 均可，cwd 必须是沙盒 server 目录）：

```powershell
Set-Location "$SB\server"
npx tsx smoke.mjs
```

需要起完整服务做 HTTP 冒烟时（换端口防撞本机 dev）：

```powershell
$env:PORT = "8967"; Set-Location "$SB\server"; npx tsx src/index.ts
```

### 5. 二次启动幂等（种子/迁移改动必测）

```powershell
$h1 = Get-ChildItem "$SB\server\data" -File -Recurse | Get-FileHash | Sort-Object Path
npx tsx smoke.mjs        # 或再次启动服务后正常退出
$h2 = Get-ChildItem "$SB\server\data" -File -Recurse | Get-FileHash | Sort-Object Path
Compare-Object $h1 $h2 -Property Hash, Path    # 输出为空 = 幂等通过
```

### 6. 清理沙盒

⚠ **先单独摘除 junction 再删沙盒**——PowerShell 5.1 的 `Remove-Item -Recurse` 可能
跟进 junction 把真实 `server\node_modules` 删掉。`rmdir`（不带 /s）只删链接本身：

```powershell
cmd /c rmdir "$SB\server\node_modules"
Remove-Item -Recurse -Force $SB
```

## 验证

- 断言分组统计全过（形如 `54/54`），失败项逐条列名。
- 二启幂等：data 文件 hash 零变化（Compare-Object 空输出）。
- 真实库零触碰实锤：冒烟前后 `$ROOT\server\data` 各文件 LastWriteTime / hash 不变。
- stub 生效实锤：冒烟全程无任何真实上游请求（未覆盖的 fetch 一律抛错即证明）。
- 输出一行可直接粘进 CLAUDE.md 的实测结论，例：
  `沙盒冒烟 54/54 + 二启幂等（data 文件零变化；scratchpad 复制 src + junction node_modules + 独立 data，stub fetch 零真实上游、真实库零触碰）`。

## 踩坑红线（历轮血泪，一条不能丢）

1. ⚠ **PowerShell 5.1 `-Encoding utf8` 写出的 settings.json 带 BOM** → 服务端
   `JSON.parse` 静默失败 = 「OSS 未配置」假象（第197轮沙盒排查过一次）。给沙盒写
   JSON 一律用 `[System.IO.File]::WriteAllText($path, $json)`（无 BOM）或由 Node 脚本写。
2. ⚠ **脚本结尾用 `process.exitCode`，不要用 `process.exit()`**——Windows 带未决
   句柄硬退偶发 `0xC0000409` 崩码（第226轮沙盒实测）。
3. ⚠ **伪 S3 若在本进程内，子进程必须异步 spawn**——`execFileSync` 堵死事件循环
   → 伪 S3 无法应答 → 下载全超时（第226轮迁移脚本测试教训）。
4. ⚠ **无 body 的 `DELETE`/`POST` 不能带 `Content-Type: application/json`**——
   Fastify 拒空 JSON body（第101轮 POST、第165轮 DELETE 两次踩同款）。无 body 就
   不带该头；必须带头时给空对象 body `"{}"`。
5. ⚠ **必须跑二次启动幂等**（data 文件 hash 零变化）——种子/补种/迁移代码跑第二遍
   不得再写盘；漏测=部署后每次重启都重复迁移（第222轮起沙盒标配 `×2` 幂等验证）。

## 相关文件

| 用途 | 路径 |
|---|---|
| DATA_DIR 模块相对推导（沙盒天然独立 data 的根据） | `server\src\store\db.ts`（第 12–13 行） |
| .env 模块相对加载 + 各渠道 BASE_URL/API_KEY 兜底 | `server\src\config.ts` |
| 契约 re-export（沙盒必须镜像两层结构的根据） | `server\src\contract.ts` |
| 根契约（零依赖单文件，沙盒只需复制它） | `src\contract.ts` |
| 服务入口（起完整服务做 HTTP 冒烟时用） | `server\src\index.ts` |
| tsx 运行脚本（dev/start/typecheck） | `server\package.json` |
| SQLite 连接（qiji.db 落 DATA_DIR） | `server\src\store\sqlite.ts` |
| 提示词 md 原稿（seed 时经 readSkill 读入，需随沙盒复制） | `server\skills\` |
| **真实开发库（绝不能被冒烟污染）** | `server\data\`（models.json / channels.json / modes.json / qiji.db 等） |
