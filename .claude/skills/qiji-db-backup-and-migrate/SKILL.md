---
name: qiji-db-backup-and-migrate
description: Qiji 服务端数据库（SQLite 台账 qiji.db）备份、P0 结构迁移与台账↔OSS 桶对账：migrate-p0/reconcile/verify 三脚本默认 dry-run、--apply 才写库。触发词：备份数据库、结构迁移、对账、孤儿资产、清理旧备份、清渠道商日志。
---

# 数据库备份与迁移（P0 运维）

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。下文本机路径均相对该项目根。
> **`server\scripts\README-P0.md` 已是完整运维手册**——本 skill 只做「入口 + 红线 + 何时用哪个脚本」，参数细节、对账语义、安全闸说明一律以该 README 为准。
> 服务器侧命令全部是 **Linux bash**（1Panel 终端，`docker compose` 命令在 compose 文件所在目录执行）；本 skill 无本机 PowerShell 步骤。

## 何时使用

- 服务端 SQLite 台账（`server\data\qiji.db`）做结构变更 / 存量迁移前后。
- 台账与 OSS 桶对不上：`size_bytes` 缺失、桶里对象没了（死链）、桶里有对象台账没行（孤儿）。
- 迁移/对账后要一个只读体检结论（结构、自洽、对桶一致、容量分布）。
- 清理渠道商归属的请求记录（`purge-agent-logs.mjs`）。
- 服务器 data/ 里整库备份堆积要清理（第222轮曾堆到 16 份 ≈12.5GB，用户令只留最新一份）。

## 何时用哪个脚本

| 场景 | 脚本 | 停服？ | 写入 |
|---|---|---|---|
| `assets` 表加 7 列 + 4 索引 + 存量标 `storage='legacy'` | `server\scripts\migrate-p0.mjs` | **不需要**（已实测） | 库 |
| 台账↔桶对账：回填 `size_bytes` / 死记录打墓碑 / 孤儿补台账 | `server\scripts\reconcile.mjs` | 不需要 | 库 |
| 只读校验（结构、自洽、对桶一致、容量分布） | `server\scripts\verify.mjs` | 不需要 | **无**（无 `--apply`） |
| 清渠道商请求记录（logs + log_details 同删） | `server\scripts\purge-agent-logs.mjs` | **必须停服**（或跑完立刻重启） | 库 |

三个 P0 脚本共用 `server\scripts\_p0lib.mjs`（**零 server 源码依赖是刻意设计**：不触发 assets.ts 首启迁移等副作用、不与在跑的服务抢内存状态——改脚本时不要引入 `server/src` 的 import）。**全部默认 dry-run，不带 `--apply` 绝不写库/写桶。**

另注：models/modes/families/templates 的**启动幂等迁移**（补种、定向迁移、墓碑）写在 `server\src\store\` 对应文件的模块加载段，随 `docker compose up -d --build` 部署自动执行，不属于本 skill 的手工脚本范畴。

## 前置检查

1. **确认在服务器上、对实时台账操作**（红线 3）。本机只负责改脚本源码；对账绝不能对下载的 db 快照跑。
2. 脚本是否已在容器内：`server/` 源码是 `COPY server/ ./` 进镜像的，本机新改的脚本要么 `docker compose cp` 送进去（方式 A，不重启），要么随 `docker compose up -d --build` 重建（方式 B）。
3. 备份未做前不动 `--apply`（见步骤 2，1 分钟的事别跳过）。
4. 跑 `purge-agent-logs.mjs` 前确认服务端已停——logs 索引常驻服务端内存，进程活着时删库会被内存回写。

## 步骤

以下全部在**服务器 Linux bash**（1Panel 终端）执行。

### 1. 把脚本送进容器

```bash
# 方式 A（推荐，不重启服务）
docker compose cp server/scripts qiji-server:/app/server/

# 方式 B（顺带更新服务端代码时）
docker compose up -d --build
```

### 2. 备份（1 分钟，别跳过）

```bash
docker compose exec qiji-server sh -c 'cd /app/server/data && cp qiji.db "qiji.db.bak-$(date +%Y%m%d-%H%M)"'
docker compose exec qiji-server sh -c 'ls -la /app/server/data | grep bak'
```

回滚 = 停服 → 把 `.bak-*` 覆盖回 `qiji.db`（连同 `-wal`/`-shm` 一起删）→ 启服。P0 只加列不改列，旧代码读新表完全正常，基本用不到回滚。

### 3. 结构迁移（dry-run → 核对 → --apply）

```bash
docker compose exec qiji-server node scripts/migrate-p0.mjs           # dry-run 看计划
docker compose exec qiji-server node scripts/migrate-p0.mjs --apply   # 核对无误后真执行
```

幂等可重复跑（已存在的列/索引跳过）；**不需要停服**——ALTER TABLE ADD COLUMN + CREATE INDEX 是瞬时元数据变更，服务端预编译语句照常读写（已实测，脚本头注释与 README 均有记载）。

### 4. 对账（dry-run 落报告 → 人工确认 → --apply）

```bash
docker compose exec qiji-server node scripts/reconcile.mjs --report=/app/server/data/p0-reconcile.json
# 把 dry-run 输出核对确认后再：
docker compose exec qiji-server node scripts/reconcile.mjs --apply
```

- 内置安全闸（主动中止、退出码 2）：桶列到 **0 个对象** / 死记录占比 **>20%**（确认无误才加 `--force`）——后者多半就是「配错桶/前缀」或「对着旧快照跑」。
- 可选开关：`--prefix=` / `--no-size` / `--no-mark-dead` / `--no-adopt` / `--force` / `--report=`，语义详见 README 第 4 节。
- 死记录**只打墓碑（`purged_at`）、行永不删**——删了行客户端的死链自愈（`reputAsset`）永远修不回来。

### 5. 清理旧备份（按需）

只留最新一份 `qiji.db.bak-*`，其余手工删。**在宿主机上找 data 目录须 `docker inspect qiji-server` 查 `Mounts`**——`/opt/qiji` 是 1Panel 显示的容器内路径，别按它在宿主机上找（第222轮踩过）。容器内直接删也可以：

```bash
docker compose exec qiji-server sh -c 'ls -la /app/server/data | grep "qiji.db.bak"'
```

### 附：清渠道商请求记录（独立场景，必须停服）

脚本头注释给两种姿势：停服后跑，**或跑完立刻重启**。容器停了就没法 `docker compose exec`，所以实操走后者：

```bash
docker compose exec qiji-server node scripts/purge-agent-logs.mjs                 # 无参=只列归属分布（只读，随时可跑）
docker compose exec qiji-server node scripts/purge-agent-logs.mjs --owner=<id> --apply
docker compose restart qiji-server                                                # --apply 后必须立刻重启，防内存索引回写
```

无参运行只列归属分布不动数据；范围用 `--owner=<id>` 或 `--all-agents`，可加 `--before=YYYY-MM-DD`；源站直属记录（owner=''）脚本永不触碰；`--apply` 时脚本自动先备份 qiji.db。

## 验证

```bash
docker compose exec qiji-server node scripts/verify.mjs --report=/app/server/data/p0-verify.json
```

- **退出码：`0`=全绿　`1`=有不一致（细节看输出）　`2`=环境/配置问题**（已通读 verify.mjs 头部确认）。
- `--no-bucket` 跳过列桶（只查库结构与台账自洽，秒级）；输出含容量分布（按类型/按年龄），是后续清理策略的实测依据。
- 结构未就绪（缺列）时 verify 直接以退出码 1 提前结束并提示先跑 migrate。

## 踩坑红线

- ⚠ **结构迁移不需要停服**（已实测：另一连接 ALTER TABLE + CREATE INDEX 后，服务端预编译语句照常读写，SQLite 自动重编译）——别为它安排停机窗口，也别因此顺手把服务停了又忘开。
- ⚠ **`purge-agent-logs.mjs` 必须停服后跑**（或跑完立刻重启）——请求记录索引常驻服务端内存，进程活着时删库，被删的行会在下次落盘时被内存回写。
- ⚠ **对账脚本必须在服务器上对实时台账跑**——对下载的静态 `qiji.db` 快照跑，会把快照之后新产生的正常对象**全部误判成孤儿**（本项目踩过一次，reconcile.mjs 头注释有记载）。
- ⚠ **孤儿补台账必须同步抬高 `asset_seqs`**——补登的 id 可能比当前 seq 大，不抬会分配出重复资产 id（reconcile.mjs 已内置该逻辑，自己写补登脚本时同规）。
- ⚠ 台账行**永不删除**，清理一律打 `purged_at` 墓碑——`reputAsset()` 第一行 `if (!rec) return undefined`，行没了「死链自愈重传」永远修不回来。
- ⚠ 不带 `--apply` 一律 dry-run；reconcile 的 >20% 死记录安全闸未查明原因前**不要加 `--force`**。
- ⚠ 宿主机上找 data 目录用 `docker inspect qiji-server` 查 `Mounts`——`/opt/qiji` 是容器内路径（1Panel 视角）。

## 相关文件

| 用途 | 路径 |
|---|---|
| **完整运维手册（细节以此为准）** | `server\scripts\README-P0.md` |
| 结构迁移（7 列 + 4 索引，默认 dry-run） | `server\scripts\migrate-p0.mjs` |
| 台账↔桶对账（回填/墓碑/孤儿补登，默认 dry-run） | `server\scripts\reconcile.mjs` |
| 只读校验（退出码 0/1/2，永不写） | `server\scripts\verify.mjs` |
| 脚本公共库（零 server 源码依赖，刻意设计） | `server\scripts\_p0lib.mjs` |
| 清渠道商请求记录（必须停服） | `server\scripts\purge-agent-logs.mjs` |
| 同规约脚本：收藏/共享库素材搬桶（默认 dry-run，无需停服） | `server\scripts\migrate-fav-shared.mjs` |
| 同规约脚本：修 `.bin` 后缀存量（默认 dry-run，`--id=` 可定向） | `server\scripts\fix-octet-assets.mjs` |
| SQLite 台账本体（+`-wal`/`-shm`） | `server\data\qiji.db` |
| JSON 持久层（models/modes/channels/families/users/agents/settings/templates/presets…） | `server\data\*.json` |
| 启动幂等迁移段（补种/定向迁移/墓碑，随部署自动跑） | `server\src\store\models.ts`、`modes.ts`、`families.ts`、`templates.ts` |
| 存储改造总方案（P0–P5 分期、表结构、实测数据） | `docs\存储与数据结构改造方案.md` |
