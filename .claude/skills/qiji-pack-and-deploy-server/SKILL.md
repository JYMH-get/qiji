---
name: qiji-pack-and-deploy-server
description: 打包 Qiji 服务端为 qiji-server-deploy.tgz，经 1Panel 上传 /root、tar 解压到 /opt/qiji、docker compose up -d --build 部署，最后用本轮验证词 grep 确认新代码上线。触发词：部署服务端、重新部署、打包服务端、接新渠道后上线、服务端更新。
---

# 打包并部署服务端

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。下文本机路径均相对该项目根；服务器侧路径为绝对路径。

## 何时使用

- 服务端（`server\`）代码有改动，CLAUDE.md 本轮记录标注「须重新部署服务端」。
- 接入新上游渠道后（部署 + 部署后到管理端填密钥/占位配置）。
- 客户端零改动的轮次也经常需要部署——模式/模型/模板全走 catalog 热更（≤30s），只要服务端上线即对新旧客户端生效。

## 前置检查

1. **先跑本轮统一自检**（qiji-preflight-check 流程）：`server` 目录 `npx tsc --noEmit` 干净；改过 `server\src\admin\index.html` / `server\src\agent\index.html` 则必须做 `<script>` 语法校验（tsc 覆盖不到，漏了=控制台整页白屏）。
2. 确认本轮改动清单：服务端 / 客户端 / 两者（CLAUDE.md 每轮都标，决定是否还要打客户端包）。
3. **确定本轮「部署验证词」**：本轮新增的独有字符串（新函数名、新文案），部署后在服务器上 `grep -c` 应恰为 1。CLAUDE.md 每轮记录里通常已给出这一条。
4. 本轮若新增了 npm 依赖，记下依赖名（见步骤 3 的依赖注意项）。

## 步骤

### 1. 本机打包 —— 本机 PowerShell 5.1（不支持 `&&`，命令逐条执行）

```powershell
powershell -ExecutionPolicy Bypass -File E:\Kaifa\Qiji\qiji\server\scripts\pack-deploy.ps1
```

脚本可从任意目录执行（自解析项目根=脚本上两级），产物落在仓库根：`qiji-server-deploy.tgz`。

**实际打包内容**（已通读 `server\scripts\pack-deploy.ps1` 确认）：

| 打进包 | 说明 |
|---|---|
| `src\contract.ts` | 共享契约单文件（`server\src\contract.ts` 运行时 re-export 仓库根这份，缺它启动即炸；脚本对它有存在性 sanity check） |
| `server\` 整目录 | robocopy /E，**排除 `node_modules`、`data` 目录与 `*.log`**；并从打包副本中**删除 `server\.env`**（保留 `.env.example`，真密钥只在服务器维护） |
| `docker-compose.yml`、`.dockerignore` | 部署编排与构建排除清单 |

不包含：客户端源码（除 contract.ts）、dist、src-tauri、docs、`server\data`（生产数据在服务器卷里）、`server\.env`。
打包用 Windows 内置 tar（bsdtar，正斜杠路径）——规避 Compress-Archive 反斜杠导致 Linux 解压路径错乱的 bug；中间目录 `_deploy` 打完自动删除。

### 2. 上传 —— 1Panel 面板（用户定稿流程）

- 在 1Panel 文件管理里把 `qiji-server-deploy.tgz` 上传到服务器 **`/root`**。
- **用户明确拒绝 scp——不要提供、不要建议任何 scp 方案。**

### 3. 解压 + 构建启动 —— 服务器 Linux bash（1Panel 终端）

```bash
tar xzf /root/qiji-server-deploy.tgz -C /opt/qiji
cd /opt/qiji
docker compose up -d --build
```

- **`--build` 必带**（用户定稿）：不带 --build 只是重启旧镜像，新代码完全不生效。
- **本轮有新依赖时**（历史上 nodemailer / undici / @aws-sdk/s3-request-presigner 都因漏装导致启动失败）：清单流程为先 `cd /opt/qiji/server && npm i` 再回到 `/opt/qiji` 执行 up --build。镜像内依赖最终由 `server\Dockerfile` 的 `npm ci` 按随包上传的 `server\package-lock.json` 安装——所以本机加依赖后务必确认 lockfile 已更新并重新打包。

### 4. 部署后动作（按本轮 CLAUDE.md 标注执行）

- 接新渠道的轮次：管理端「渠道」页填上游密钥；有占位配置的（如 autodl 的三个 workflow_id、congge 的 sk- 密钥）逐项填齐——不填提交会明确报错不扣费。
- 需要迁移/运维脚本的轮次：`docker compose exec qiji-server node /app/server/scripts/<脚本>.mjs` 先看 dry-run 输出，核对无误再加 `--apply`。
- 观察首启是否阻塞（见「验证」第 3 条）。

## 验证 —— 服务器 Linux bash

```bash
# 1) 部署验证词：本轮独有字符串 grep 计数应为 1（每轮换词，下面是历史轮次的真实示例）
grep -c pruneInvalidCodes /opt/qiji/server/src/store/redeemCodes.ts
grep -c 渠道形式的模式不再按用户开关 /opt/qiji/server/src/admin/index.html

# 2) 健康检查（端口只绑 127.0.0.1，公网一律走 1Panel 反向代理）
curl -s http://127.0.0.1:8787/health

# 3) 首启日志
docker compose logs --tail 100 qiji-server
```

- 验证词 grep = 1 才算「新代码真上线」；= 0 说明解压/构建没生效（多半是旧包或没带 --build）。
- **旧包快速判据**（第181轮事故）：客户端报 404 而服务端字段看着正常 = 上传的 tgz 是旧包——用 `ls /opt/qiji/server/src/store/favorites.ts` 之类「本轮新文件的存在性」一秒判定。
- **首启可能长时间阻塞，不是挂了**：第222轮清存量日志 + VACUUM 2.4GB 阻塞 1–3 分钟（日志会打「[logs] VACUUM 完成」）；第198轮 39 万行回填阻塞数秒。等日志走完再判断。

## 踩坑红线

- ⚠ **构建上下文必须是仓库根**：`server/src/contract.ts` 运行时 re-export 根 `src/contract.ts`，镜像里必须同时有 `/app/server` 与 `/app/src/contract.ts`。docker-compose.yml 已写死 `context: .` + `dockerfile: server/Dockerfile`；手动构建等价命令是 `docker build -f server/Dockerfile -t qiji-server .`（在仓库根执行）。
- ⚠ **不能用 `--omit=dev`**：服务端用 tsx 运行时直跑 .ts 不编译，tsx 是 devDependency——省掉 dev 依赖=容器起不来。Dockerfile 的 `npm ci` 默认含 devDependencies，勿改。
- ⚠ **`/opt/qiji` 在宿主机上并不存在**——那是 1Panel 显示的容器内视角路径；要在宿主机上找 data 目录，用 `docker inspect qiji-server` 查 `Mounts`（第222轮清理 12.5GB 备份时踩过）。部署命令在 1Panel 终端里执行时 `/opt/qiji` 有效。
- ⚠ **部署事故判据（第181轮）**：客户端报 404 而服务端字段正常 = 上传的 tgz 是旧包，用 `ls /opt/qiji/server/src/store/favorites.ts` 之类的文件存在性快速判定，别按新 bug 排查。
- ⚠ **首启可能长时间阻塞**（第222轮 VACUUM 2.4GB 阻塞 1–3 分钟；第198轮 39 万行回填阻塞数秒）——要提前告知用户不是挂了，看容器日志等它走完。
- ⚠ **`--build` 必带、上传只走 1Panel、不用 scp**——三条均为用户定稿流程，勿自作主张替换。
- ⚠ **真密钥绝不进包/进镜像**：`server\.env` 由打包脚本剥离、`.dockerignore` 双重排除，只在服务器上维护；`server\data` 同理（数据走卷挂载 `./server/data:/app/server/data`，删容器不丢数据）。

## 相关文件

| 用途 | 路径 |
|---|---|
| 部署打包脚本（本 skill 主脚本） | `server\scripts\pack-deploy.ps1` |
| 全项目迁移打包脚本（换机场景，非日常部署用） | `server\scripts\pack-project.ps1` |
| 部署编排（context=仓库根、端口只绑 127.0.0.1、data 卷、env_file=server/.env） | `docker-compose.yml` |
| 服务端镜像定义（node:24-slim、npm ci 含 dev、契约落 /app/src/contract.ts） | `server\Dockerfile` |
| 构建上下文排除清单（node_modules/data/.env/客户端产物） | `.dockerignore` |
| 共享契约（打包唯一带上的根 src 文件） | `src\contract.ts` |
| 打包产物（打完出现在仓库根） | `qiji-server-deploy.tgz` |
| 服务器部署目录（1Panel 终端视角） | `/opt/qiji`（服务器侧） |
| 上传落点（1Panel 面板上传目标） | `/root`（服务器侧） |
