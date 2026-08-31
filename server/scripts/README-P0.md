# P0 存储改造 · 运维手册

三个脚本，**默认 dry-run**（不带 `--apply` 绝不写库/写桶）。
完整方案见 [docs/存储与数据结构改造方案.md](../../docs/存储与数据结构改造方案.md)。

| 脚本 | 作用 | 写入 |
|---|---|---|
| `migrate-p0.mjs` | `assets` 表加 7 列 + 4 索引 + 存量标 `storage='legacy'` | 库 |
| `reconcile.mjs` | 台账 ↔ 桶 对账：回填 `size_bytes` / 死记录打墓碑 / 孤儿补台账 | 库 |
| `verify.mjs` | 只读校验（结构、自洽、对桶一致、容量分布） | 无 |

> ⚠ **必须在服务器上、对实时台账跑。** 对下载的静态 `qiji.db` 快照跑，会把快照之后新产生的正常对象全部误判成孤儿。

---

## 1. 把脚本送进容器

服务是 `docker compose`，`server/` 源码在镜像里（`COPY server/ ./`），所以新脚本要么重建镜像、要么直接拷进去。

**方式 A（推荐，不重启服务）**

```bash
docker compose cp server/scripts qiji-server:/app/server/
```

**方式 B（顺带更新服务端代码时）**

```bash
docker compose up -d --build
```

---

## 2. 备份（别跳过；禁止运行中直接复制）

```bash
# 默认安全方案：停止唯一写入者后做文件级复制
docker compose stop qiji-server
cp server/data/qiji.db "server/data/qiji.db.bak-p0-$(date +%Y%m%d-%H%M)"
docker compose start qiji-server
ls -la server/data/ | grep bak-p0
```

> 不能停服时，只能使用 SQLite 原生 `VACUUM INTO` 或 `.backup` 在线备份，并先确认容器内工具可用。禁止对运行中的 `qiji.db` 直接 `cp`；“连同 WAL/SHM”不是运行中复制的许可。

> 回滚 = 停服 → 把 `.bak-p0-*` 覆盖回 `qiji.db`（连同 `-wal`/`-shm` 一起删）→ 启服。
> 但 P0 只加列不改列，服务端旧代码读新表完全正常，**基本不会用到回滚**。

---

## 3. 结构迁移

```bash
docker compose exec qiji-server node scripts/migrate-p0.mjs
```

看清计划后：

```bash
docker compose exec qiji-server node scripts/migrate-p0.mjs --apply
```

**不需要停服。** 已实测：另一连接 `ALTER TABLE ADD COLUMN` + `CREATE INDEX` 后，服务端的预编译语句照常读写（SQLite 自动重编译；服务端语句都显式列了列名）。整个操作是瞬时元数据变更，不重写表。

---

## 4. 对账

先 dry-run，并把明细落一份 JSON：

```bash
docker compose exec qiji-server node scripts/reconcile.mjs --report=/app/server/data/p0-reconcile.json
```

**把输出发我确认后**再执行：

```bash
docker compose exec qiji-server node scripts/reconcile.mjs --apply
```

### 内置安全闸（会主动中止，退出码 2）

- 桶里列到 **0 个对象** → 中止（配置/权限问题，绝不在这种状态下标死记录）
- 死记录占台账 **>20%** → 中止（多半是桶/前缀配错，或对着旧快照跑）；确认无误加 `--force`

### 可选开关

```
--prefix=assets/     只对账该前缀，其余对象与台账行一律「不判断」
--no-size            不回填 size_bytes
--no-mark-dead       不标死记录（只做 size 回填 + 孤儿补登）
--no-adopt           不补登孤儿
--force              越过 >20% 安全闸
--report=<路径>      落 JSON 明细
```

### 三件事的语义

1. **回填 `size_bytes`** —— 配额与容量统计的基础。
2. **死记录打墓碑** —— 台账有行、桶里没对象 → `purged_at = 现在`。
   ⚠ **行永不删除**：`store/assets.ts` 的 `reputAsset()` 第一行是 `if (!rec) return undefined`，
   删了台账行，客户端拿本地副本做的「死链自愈重传」就永远修不回来了。
3. **孤儿补登** —— 桶里有对象、台账没行 → 按对象键反解 id 补台账，
   并**同步抬高 `asset_seqs`**（补登的 id 可能比当前 seq 大，不抬会分配出重复 id）。

**不自动处理、只进报告**的两类：
- `id` 已被台账占用的孤儿（同 id 不同扩展名）
- 对象键不符合 `<前缀><8位>.<ext>` 命名的（如 `_admin_test.txt`）

---

## 5. 校验

```bash
docker compose exec qiji-server node scripts/verify.mjs --report=/app/server/data/p0-verify.json
```

退出码：`0`=全绿　`1`=有不一致　`2`=环境/配置问题。
`--no-bucket` 可跳过列桶（只查库结构与台账自洽，秒级）。

输出含容量分布（按类型 / 按年龄分档），是 §8 容量测算与后续清理策略的实测依据。

---

## 6. 完成后

P0 剩下的部分要改服务端代码（storage profile 落地、`reputAsset`/`ossDelete`/`ossPresignPut` 按档定位、管理端「存储」页），走正常的 `docker compose up -d --build` 部署。

## 已知边界

- `size_bytes` 是**对账那一刻**的快照；新资产由后续服务端代码在 `createAsset`/`commitDirectAsset` 时直接写入（P0 代码改动部分）。
- 迁移与对账之间新写入的行 `storage` 为 `NULL` —— 服务端把 `NULL` 一律当 `legacy` 解读，不算错。
- 无 `oss_key` 的台账行（未配 OSS 时期的内存态记录）不参与对账，只在报告里计数。
