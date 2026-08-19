---
name: qiji-preflight-check
description: Qiji 改动后统一自检套件：server/client tsc、全量 vitest（基线602）、vite build、admin/agent 控制台 HTML 的 script 语法校验、cargo check、dist 产物实锤。凡改完代码收尾、准备「部署服务端」「打包客户端」「接新渠道」「更新模型」时触发。
---

# Qiji 改动后统一自检套件

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。下文所有相对路径与命令均以项目根为基准。
> 全部步骤在**本机**执行，无需登录服务器。

## 何时使用

- 每轮改动收尾时（CLAUDE.md 第 168–234 轮无一例外都以这串检查收口），**在打包 tgz / 部署服务端 / tauri build 之前**必须全套跑完。
- 触发场景：改了服务端 `server/src/**`、客户端 `src/**`、管理端 `server/src/admin/index.html`、门户 `server/src/agent/index.html`、Rust `src-tauri/**`，或接入新渠道/新模型后的收尾。
- 漏一项 = 「改了没测」直接进部署。尤其 admin/agent HTML 的 script 语法错误 **tsc 完全抓不到**，漏检的后果是控制台整页白屏。

## 前置检查

1. **确认改动面清单**，决定必跑步骤（下表）。不确定就全跑。

   | 改动了什么 | 必跑步骤 |
   |---|---|
   | `server/src/**`（.ts） | 步骤 1 |
   | 客户端 `src/**` | 步骤 2（tsc + vitest + build） |
   | `server/src/admin/index.html` 或 `server/src/agent/index.html` | 步骤 3（**必做，tsc 覆盖不到**） |
   | `src-tauri/src/lib.rs` 等 Rust | 步骤 4 |
   | `src/store/connectionStore.ts` 的 `DEFAULT_SERVER_URL` 等影响客户端产物分支的代码 | 步骤 5 |

2. **清查 tsx 僵尸进程**（若本轮要用本机 dev 8787 做冒烟验证）。8787 上若挂着**不带 watch** 的 `tsx src/index.ts`，永不热重启，冒烟会跑在旧代码上（历史上第 107/112/115/118/134/145/148/163/178 轮反复踩）。
   本机 PowerShell 5.1：
   ```powershell
   Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "tsx" } | Select-Object ProcessId, CommandLine
   ```
   发现不带 watch 的实例或多个 watch 父进程 → 全树清杀后重启 dev。

3. 确认 `node_modules` 与 `server/node_modules` 就位（缺则各自 `npm i`）。

## 步骤

> 环境说明：**本机 PowerShell 5.1 不支持 `&&`**，多命令用 `;` 分隔；Git Bash 可用 `&&`。以下命令两种 shell 都给出或注明。

### 1. 服务端 tsc（改了 server/src 必跑）

本机 PowerShell 5.1：
```powershell
cd E:\Kaifa\Qiji\qiji\server; npx tsc --noEmit
```
本机 Git Bash：
```bash
cd /e/Kaifa/Qiji/qiji/server && npx tsc --noEmit
```
零输出 = 干净。等价于 `npm run typecheck`（见 `server\package.json`）。

### 2. 客户端 tsc + 全量 vitest + build（改了 src/ 必跑）

在项目根依次执行（PowerShell 5.1 用 `;` 串联，Git Bash 用 `&&`）：
```powershell
cd E:\Kaifa\Qiji\qiji
npx tsc --noEmit
npx vitest run
npm run build
```
- `npx tsc --noEmit` = `npm run typecheck`。
- `npx vitest run` = `npm run test`：**全量 vitest 通过（当前基线 602）**。用例数会随功能增减变化——若数量变了，在结论里写明「602→N（+M 新增 / −M 删除）」，不要把 602 当死数。vitest 配置在根 `vitest.config.ts`（含 `appVersionPlugin` 解析 `virtual:app-version`，`include` 为 `src/**/*.{test,spec}.{ts,tsx}`）。
- `npm run build` = `tsc -b && vite build`（package.json 内的 `&&` 由 npm 的 cmd shell 执行，PS 5.1 下直接 `npm run build` 即可）。

### 3. admin/agent 控制台 HTML script 语法校验（改了这两个 HTML 必做）

两个文件各内嵌**一个巨型 `<script>` 块**（admin 约 3400+ 行脚本，agent 约 1100+ 行；行号随迭代漂移，勿硬编码）。抽出 script 正文后用 `new Function()` 编译校验——tsc 对它们零覆盖。

单行命令，**仅 Git Bash**（在项目根执行；node 按 UTF-8 直读文件，绕开 PS 默认编码坑。⚠ 勿在 PowerShell 5.1 里跑这条单行——PS 5.1 向原生程序传参会剥离内嵌双引号，node 收到的脚本必报 SyntaxError）：
```bash
node -e 'const fs=require("fs");let bad=0;for(const f of ["server/src/admin/index.html","server/src/agent/index.html"]){const m=fs.readFileSync(f,"utf8").match(/<script>([\s\S]*)<\/script>/);if(!m){console.error(f+": 未找到 <script> 块");bad=1;continue}try{new Function(m[1]);console.log(f+": script 语法 OK")}catch(e){console.error(f+": 语法错误 -> "+e.message);bad=1}}process.exitCode=bad'
```

本机 PowerShell 5.1（先把校验脚本落成临时文件再执行——内容不经命令行传参，无引号剥离问题；脚本内容为纯 ASCII，避开编码坑）：
```powershell
cd E:\Kaifa\Qiji\qiji
@'
const fs=require("fs");let bad=0;
for(const f of ["server/src/admin/index.html","server/src/agent/index.html"]){
  const m=fs.readFileSync(f,"utf8").match(/<script>([\s\S]*)<\/script>/);
  if(!m){console.error(f+": no <script> block");bad=1;continue}
  try{new Function(m[1]);console.log(f+": script OK")}catch(e){console.error(f+": syntax error -> "+e.message);bad=1}
}
process.exitCode=bad
'@ | Set-Content -Encoding Ascii _check_html.js
node _check_html.js; Remove-Item _check_html.js
```
等价做法（`node --check`，逐文件；Git Bash）：
```bash
cd /e/Kaifa/Qiji/qiji
node -e 'const fs=require("fs");fs.writeFileSync("_admin_script.js",fs.readFileSync("server/src/admin/index.html","utf8").match(/<script>([\s\S]*)<\/script>/)[1])' && node --check _admin_script.js && rm _admin_script.js
node -e 'const fs=require("fs");fs.writeFileSync("_agent_script.js",fs.readFileSync("server/src/agent/index.html","utf8").match(/<script>([\s\S]*)<\/script>/)[1])' && node --check _agent_script.js && rm _agent_script.js
```
两种做法在历轮记录中都被使用过（第 228 轮用 `new Function`，多数轮用 `node --check`），任选其一，临时 .js 文件用完即删。

### 4. cargo check（动了 src-tauri Rust 才跑）

本机 PowerShell 5.1：
```powershell
cd E:\Kaifa\Qiji\qiji\src-tauri; cargo check
```

### 5. dist 产物实锤（动了 DEFAULT_SERVER_URL 等产物分支才跑）

`src/store/connectionStore.ts:18`：`DEFAULT_SERVER_URL = import.meta.env.DEV ? "http://localhost:8787" : "http://103.120.91.71:8787"`。build 后 grep dist 确认打包分支正确、DEV 分支被摇树（第 225 轮的验证做法；换服务器/上域名后以该行当前值为准）：

本机 Git Bash：
```bash
cd /e/Kaifa/Qiji/qiji
grep -c "103.120.91.71:8787" dist/assets/*.js   # 应 ≥1（打包分支在）
grep -c "http://localhost:8787" dist/assets/*.js # 应为 0（DEV 分支被摇树）
```
本机 PowerShell 5.1：
```powershell
Select-String -Path E:\Kaifa\Qiji\qiji\dist\assets\*.js -Pattern "103\.120\.91\.71:8787" | Measure-Object | Select-Object Count   # 应 ≥1（打包分支在）
Select-String -Path E:\Kaifa\Qiji\qiji\dist\assets\*.js -Pattern "http://localhost:8787" -SimpleMatch | Measure-Object | Select-Object Count   # 应为 0（DEV 分支被摇树）
```

### 6. 汇总一行实测结论（写进 CLAUDE.md 用）

按历轮固定格式汇总，例如：
```
server tsc 干净 + client tsc 干净 + 602 vitest 全过 + vite build 过 + admin/agent script 语法过（+ cargo check 过 / dist 产物 grep 实锤）
```
只写实际跑过的项；vitest 数量变化要写明增减。

## 验证

- 步骤 1/2 的 tsc：命令零输出、退出码 0。
- vitest：输出 `Test Files N passed` 且无 failed/skipped 意外项；总数对照基线 602 核对增减原因。
- build：`vite build` 正常产出 `dist/`，无 error（警告另行判断）。
- 步骤 3：两个文件都打印 `script 语法 OK`；任一报语法错误 = 阻断，修完重跑。
- 步骤 5：两条 grep 计数符合预期。
- 全套绿了才允许进入打包/部署流程（打包部署见 `qiji-pack-and-deploy-server` 相关流程）。

## 踩坑红线

- ⚠ **admin/agent HTML 的 `<script>` 语法错误 tsc 完全抓不到**——改了这两个文件不跑步骤 3，后果是控制台整页白屏。这是本套件里唯一 tsc 零覆盖的独有陷阱，一条不能省。
- ⚠ **漏检即带病部署**：这串检查项每轮必跑、顺序固定但分散在多个目录和执行器（tsc×2、vitest、vite、node、cargo），漏任何一项就是「改了没测」直接进部署。
- ⚠ **602 不是死数**：写结论用「全量 vitest 通过（当前基线 602）」；数量变了必须在结论里说明增减来源（新增/删除了哪些用例），无解释的减少要当回归查。
- ⚠ **校验 HTML 必须按 UTF-8 读**（第 147 轮教训）：PowerShell 默认编码会把中文读坏、产生假语法错——步骤 3 的命令用 node `readFileSync(f,"utf8")` 直读，勿改成 PS `Get-Content` 管道喂给校验器。
- ⚠ **tsx 僵尸进程 = 冒烟白测**（第 107/112/115/118/134/145/148/163/178 轮惯犯）：8787 上不带 watch 的 `tsx src/index.ts` 永不热重启，一切基于 dev 8787 的验证都会跑在旧代码上，观感是「改了代码不生效」。先按前置检查 2 清查。
- ⚠ **PowerShell 5.1 不支持 `&&`**：多命令用 `;` 串联或分行执行；`npm run build` 内部的 `&&` 由 npm 调 cmd 执行，不受影响。
- ⚠ **动了客户端产物相关代码（如 `DEFAULT_SERVER_URL`）必须 grep dist 实锤分支**，不能只看 build 成功——tsc/build 都不会告诉你摇树结果是不是你要的那个分支。
- ⚠ 仓库根**不能残留 `vite.config.js`**（第 144 轮）：vite 解析 `.js` 优先于 `.ts`，会静默遮蔽 `vite.config.ts` 的一切改动——build/vitest 看似过了、跑的却是旧配置。发现即删。

## 相关文件

| 用途 | 路径 |
|---|---|
| 根 typecheck / test / build 脚本定义 | `package.json` |
| server typecheck 脚本定义（tsx 直跑不编译，仅 tsc 校验） | `server\package.json` |
| vitest 配置（appVersionPlugin / alias @ / include 范围） | `vitest.config.ts` |
| 根 TS 配置 | `tsconfig.json`、`tsconfig.node.json` |
| server TS 配置 | `server\tsconfig.json` |
| 管理端控制台（单个巨型 `<script>` 块，tsc 零覆盖） | `server\src\admin\index.html` |
| 渠道商门户（单个巨型 `<script>` 块，tsc 零覆盖） | `server\src\agent\index.html` |
| Rust 工程（改 Rust 才需 cargo check） | `src-tauri\Cargo.toml`、`src-tauri\src\lib.rs` |
| 打包分支验证目标（DEFAULT_SERVER_URL，第 18 行） | `src\store\connectionStore.ts` |
| build 产物（grep 实锤对象） | `dist\assets\*.js` |
