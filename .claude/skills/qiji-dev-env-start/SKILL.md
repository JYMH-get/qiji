---
name: qiji-dev-env-start
description: 启动或修复 Qiji 本地开发环境：先清 tsx 僵尸进程，再起 8787 服务端与 5199 前端并冒烟。触发词：启动开发环境、起 dev 服务、改了代码不生效、端口被占/EADDRINUSE、清僵尸进程、动 modes/models/channels 种子代码前停服。
---

# qiji-dev-env-start —— 本地开发环境启动与端口清理

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。下文路径均相对项目根。
> 端口约定：服务端 8787 / 前端 5199（备用 5233）。服务端 dev = `tsx watch src/index.ts`（**tsx 运行时直跑 .ts 不编译**，改 .ts 自动热重启）。

## 何时使用

- 需要起本地服务端（8787）/前端（5199）做开发、调试或浏览器端到端验证。
- **「改了代码不生效」**——本项目最贵的重复浪费：tsx 僵尸进程至少踩过 9 次（第 107/112/115/118/134/145/148/163/178 轮），先按本 skill 步骤 1 排查再怀疑代码。
- 8787/5199 端口被占、新起实例 EADDRINUSE、健康检查不通。
- 准备编辑 modes/models/channels 种子代码之前（要先停 tsx watch，见踩坑红线 3）。

## 前置检查

1. **launch.json 只有一份**：`.claude\launch.json`（项目根内）。`preview_start` 读的是 `<当前会话工作目录>\.claude\launch.json`，所以**会话必须开在项目根 `E:\Kaifa\Qiji\qiji`**，开在外层壳读不到任何配置。

   配置名与内容：`qiji-client:5199`、`qiji-client-b:5233`（无 prefix 直跑 `npm run dev`）、`qiji-server:8787`（`npm --prefix server run dev`）。

   > 2026-08-18 之前外层壳 `E:\Kaifa\Qiji` 另有一份用 `--prefix qiji` 的副本（含无关的 `xiha-server:8788`），已随工作目录收敛到项目根统一为一份；旧内容留档 `.claude\launch.json.bak-outer-shell`。

2. `server\.env` 存在（本机真配置：ADMIN_TOKEN、GATEWAY_API_KEY 等；样例见 `server\.env.example`）。
3. 明确 `server\data\` 是**本机 dev 真实库**，本 skill 只启动服务，任何测试写入走沙盒（见踩坑红线 4）。

## 步骤

### 1. 先查 tsx 僵尸（本机 PowerShell 5.1，可直接复制）

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match "tsx" } | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | Format-List
```

判读：
- **重点找不带 watch 的 `tsx src/index.ts`**——它永不热重启，正占着 8787，新实例 EADDRINUSE 静默死掉，请求全打在旧代码上。
- 多于一棵 `tsx watch` 进程树也是病（两个 watch 父进程抢 8787，第 134 轮变体）。

再确认 8787 被谁占着（本机 PowerShell 5.1）：

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess
```

### 2. 全树清杀（本机 PowerShell 5.1）

对步骤 1 找到的每个父进程（把 `<PID>` 换成实际值）：

```powershell
taskkill /PID <PID> /T /F
```

`/T` 杀整棵进程树（tsx watch 的子进程跑旧代码，只杀父进程会留孤儿）。杀完**复跑步骤 1 直到零命中**。

### 3. 起服务端

- Claude Code 会话内：用 `preview_start` 起 `qiji-server`（**不要**在会话里裸跑 `npm run dev`——脱管的后台进程就是下一个僵尸）。
- 人工手起（不经 Claude）时，项目根执行：
  - 本机 PowerShell 5.1（**不支持 `&&`**，勿写 `cd server && npm run dev`）：

    ```powershell
    npm --prefix server run dev
    ```

  - 本机 Git Bash：

    ```bash
    cd server && npm run dev
    ```

### 4. 健康检查

- 本机 Git Bash（⚠ 此 curl 写法在 PowerShell 5.1 会被 Invoke-WebRequest 别名劫持，别在 PS 里跑）：

  ```bash
  curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/health
  ```

  期望输出 `200`。
- 本机 PowerShell 5.1 等价：

  ```powershell
  Invoke-RestMethod http://localhost:8787/health
  ```

  期望 `ok: True`、`service: qiji-server`（端点定义在 `server\src\index.ts`）。

### 5. 需要前端时起 qiji-client

- `preview_start` 起 `qiji-client`（5199）；**5199 被占**（常见：另一并行会话在用）改起 `qiji-client-b`（5233）。
- 人工手起（本机 Git Bash 或 PowerShell 5.1，项目根）：

  ```bash
  npm run dev -- --port 5199 --strictPort false
  ```

- dev 前端默认直连 `http://localhost:8787`——由 `src\store\connectionStore.ts:18` 的 `DEFAULT_SERVER_URL` 决定（dev 分支 localhost:8787 防误连生产 / 打包版 103.120.91.71:8787；换服务器只改这一处）。

### 6. 冒烟（本机 Git Bash）

```bash
curl -s http://localhost:8787/v1/catalog -H "Authorization: Bearer dev-key" | head -c 300
```

期望返回 catalog JSON（含 version/models）。`dev-key` 是首启种子 accessKey；若 401，说明本机 dev 库已换成真实注册用户体系——到管理端 `http://localhost:8787/admin`（ADMIN_TOKEN 本机默认 `admin-dev`，以 `server\.env` 为准）取某用户的 API 密钥替换。

## 验证

- `/health` 返回 200 且 `service=qiji-server`。
- 复跑步骤 1：机器上只剩**一棵** `tsx watch` 进程树，且没有不带 watch 的 `tsx src/index.ts`。
- 热重启活体验证：改保存任意 `server\src\` 下 .ts 文件 → 服务端控制台出现 tsx 重启日志（这是「改代码会生效」的实锤）。
- 前端起来后浏览器打开 `http://localhost:5199` 出现登录页。
- 冒烟 `/v1/catalog` 返回 JSON 非 401/404。

## 踩坑红线

1. ⚠ **不带 watch 的 `tsx src/index.ts` 僵尸**——永不热重启、正占着 8787，新实例 EADDRINUSE 静默死掉，观感就是「改了代码不生效」。已重复浪费至少 9 次调试时间（第 107/112/115/118/134/145/148/163/178 轮）。**起服前必查必清（步骤 1/2）**。
2. ⚠ **两个 `tsx watch` 父进程抢 8787**（第 134 轮）：改代码触发重启时新进程 EADDRINUSE 崩、旧进程带旧代码继续服务，同样表现为「改了不生效」。清杀必须 `taskkill /T` 按进程树全清，杀完复查到零命中。
3. ⚠ **动 modes/models/channels 种子代码前先停 tsx watch**（第 216/217 轮教训）：tsx watch 对**每次保存**都热重启，会把「编辑中间态/半成品代码」的补种与迁移**种进 `server\data\` 真实 dev 库**（第 216 轮 familyId 被中间态钉错、事后手工修正）。正确顺序：停服 → 全部编辑完 → `npx tsc --noEmit` 过 → 再重启。dev 库已沾中间态的，后续沙盒冒烟须先剥离痕迹还原部署前形状。
4. ⚠ **`server\data\` 是本机 dev 真实库**（models.json 160KB / channels.json / modes.json / qiji.db 17MB），误改就是脏数据。任何测试写入用隔离沙盒（见 skill `qiji-sandbox-smoke-test`），绝不能拿真实库冒烟。
5. ⚠ **Claude 会话内用 `preview_start` 起服，不要裸 `npm run dev`**——裸起的后台进程会话结束后脱管，正是僵尸的来源之一。
6. ⚠ **本机 PowerShell 5.1 不支持 `&&`**：`cd server && npm run dev` 是语法错误；PowerShell 用 `npm --prefix server run dev` 或分号分隔，链式命令走 Git Bash。
7. ⚠ **PowerShell 5.1 里 `curl` 是 `Invoke-WebRequest` 的别名**，带 `-s -o -w` 的 curl 命令必须在 Git Bash 执行（或改用 `Invoke-RestMethod`）。

## 相关文件

| 用途 | 路径 |
|---|---|
| 开发服务器配置（唯一一份；会话工作目录须在项目根才被 preview_start 读取） | `.claude\launch.json` |
| 服务端 dev 脚本定义（`dev` = `tsx watch src/index.ts`） | `server\package.json` |
| 本机真环境配置（ADMIN_TOKEN / GATEWAY_API_KEY 等） | `server\.env` |
| 环境变量样例（新机器初始化用） | `server\.env.example` |
| 本机 dev 真实库（误改即脏数据，测试走沙盒） | `server\data\` |
| dev 默认服务器地址 `DEFAULT_SERVER_URL`（第 18 行；dev=localhost:8787） | `src\store\connectionStore.ts` |
| 健康检查端点 `/health` | `server\src\index.ts` |
| catalog 端点 `/v1/catalog`（冒烟用） | `server\src\routes.ts` |
