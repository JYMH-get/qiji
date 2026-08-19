---
name: qiji-oss-storage-ops
description: Qiji 对象存储（OSS）运维：切换新桶/新增存储档、旧桶桥接、reconcile 对账回填、.bin 后缀修复、收藏/共享库搬桶、保留策略预览与清理开闸（off→dry→on）。触发词：换桶、换对象存储、OSS 清理、存储对账、storageProfiles、清理开闸。
---

# Qiji 对象存储运维（切换 / 对账 / 清理）

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。正文相对路径均相对该根。
> 服务器侧命令一律 **Linux bash**（SSH / 1Panel 终端）；本机命令逐条标注 PS 5.1 / Git Bash。

## 何时使用

- 换新 OSS 桶 / 新增存储档（`storageProfiles`），或旧桶整体舍弃走桥接恢复
- 台账 ↔ 桶对账：回填 `size_bytes`、死记录打墓碑、孤儿对象补登
- 修复 Content-Type/`.bin` 后缀存量资产
- 收藏 + 共享素材库素材由服务端直接搬到新桶（不等用户本地恢复）
- 保留策略（tmp/unref/ref 三档）预览与清理执行开闸推进
- 查看容量总览 / 旧桶遗留（bridgeCount）统计

## 核心口径（改代码/做操作前必读）

- **存储档（profile）**：`server/src/store/storage.ts`。每行资产带 `storage` 列（NULL=legacy）；档位解析出 {桶, 对象键, 公网前缀}。布局三种：`flat` / `kind/yyyy/mm` / `acct/kind/yyyy/mm/dd`。**换桶/换布局=改 `server/data/settings.json` 的 `storageProfiles`，不改代码**。`active:true` 且 `writable` 的唯一档=新上传落点；未配置时 legacy 兜底（=主 OSS 配置 + 平铺）。
- **retention.ts 只算不删**：`server/src/store/retention.ts` 没有任何删除能力（有意设计）。`listSweepCandidates()` 是预览与清理共用的唯一候选查询（口径永不分叉）。
- **cleanup.ts 才执行删除，三道闸**：`mode` off（默认，零动作）/ dry（只记报告）/ on（真删）＋ `scope` tmp（只清 TP）/ all ＋ 每轮 ≤2000 个（`SWEEP_BATCH`）、每小时一轮（启动 5 分钟后首轮）、并发 8。
- **旧桶桥接**：`settings.json` 的 `ossBridgeOldBases`（旧公网基址清单）。命中旧基址的行：探活直接判死（零外网探测）、`reputAsset` 恢复时 PUT 到 active 档、键=`<恢复者账号>/<旧键路径>`；**旧桶行不进清理候选、不进新 OSS 统计**（单列 bridgeCount/bridgeBytes）。
- **sha256 去重**：`createAsset` 按内容哈希命中存活对象则零上传，多行共享同一 `oss_key`。

## 前置检查

1. 关键文件在位（项目根下）：`server/src/store/{storage,oss,assets,retention,cleanup}.ts`、`server/scripts/{README-P0.md,_p0lib.mjs,migrate-p0.mjs,reconcile.mjs,verify.mjs,fix-octet-assets.mjs,migrate-fav-shared.mjs}`。
2. 服务器容器在跑（Linux bash）：
   ```bash
   docker ps --filter name=qiji-server
   ```
3. 找到真实 data 目录（⚠ `/opt/qiji` 是 1Panel 显示的**容器内**路径，宿主机 shell 未必存在）：
   ```bash
   docker inspect qiji-server --format '{{json .Mounts}}'
   ```
4. 动 settings.json / 台账前先备份（Linux bash，容器内）：
   ```bash
   docker exec qiji-server sh -c 'cd /app/server/data && cp qiji.db "qiji.db.bak-$(date +%Y%m%d-%H%M)" && cp settings.json "settings.json.bak-$(date +%Y%m%d-%H%M)"'
   ```
   备份别堆积（历史上堆过十几份把磁盘吃紧），确认无事后删旧份。
5. 管理端「存储」页可打开（含 OSS 配置 / 容量总览 / 保留策略·清理预览 / 清理执行 四块）。

## 步骤

### A. 切换新桶（新增存储档）

1. 管理端「存储」页把主 OSS 配置改成新桶：endpoint / bucket / AK / SK，publicBase 留空自动推导（`https://<bucket>.<endpoint host>`）。
2. 服务器上编辑 `server/data/settings.json`（1Panel 视角 `/opt/qiji/server/data/settings.json`；宿主机路径按前置检查 3 定位），在顶层加：
   ```json
   "storageProfiles": {
     "sy1": { "layout": "acct/kind/yyyy/mm/dd", "active": true }
   }
   ```
   - 新档字段缺省从主 OSS 配置继承（endpoint/bucket/AK/SK/publicBase/region）——所以第 1 步先改主配置。
   - **旧档若是显式配置的档，必须手动加 `"active": false`**；只有 legacy 兜底档时，新档 active:true 会让 legacy 自动失去 active。
   - ⚠ 换桶但**旧桶继续在用**时，先把旧档的 endpoint/bucket/AK/SK **显式写死**进 storageProfiles——否则旧档字段会随主配置一起漂移到新桶。
3. 旧桶数据整体舍弃时，确认 `settings.json` 的 `ossBridgeOldBases` 含旧公网基址（缺省已含 `https://jianqiji-qiji.cn-nb1.rains3.com`）。
4. 重启（Linux bash，/opt/qiji 下）：
   ```bash
   docker compose restart
   ```
5. 按「验证」节确认新上传落新档；旧桶暂缓销毁（用户本地副本也丢的素材趁旧桶在还能救）。

### B. 对账（reconcile：回填 size / 死记录墓碑 / 孤儿补登）

脚本已随部署包在容器 `/app/server/scripts/`；本地改过脚本未重新部署时先送进去：
```bash
docker compose cp server/scripts qiji-server:/app/server/
```
先 dry-run 看计划，再 `--apply`（Linux bash）：
```bash
docker exec qiji-server node /app/server/scripts/reconcile.mjs
docker exec qiji-server node /app/server/scripts/reconcile.mjs --apply
```
可选参数：`--report=/tmp/r.json`（落明细）、`--prefix=assets/`、`--no-size / --no-mark-dead / --no-adopt`、`--force`（死记录占比超 20% 安全闸时仍继续）。
结构迁移列/索引缺失时先 `node /app/server/scripts/migrate-p0.mjs --apply`（幂等，与服务端启动自动迁移等价）。**结构迁移与对账均无需停服**。

### C. 收藏/共享库素材搬新桶（migrate-fav-shared.mjs）

目标=favorites 全部 asset_id ∪ shared-libs 素材中仍指旧桶的行；语义与 `reputAsset` 桥接分支一致（键=`<归属账号>/<旧路径>`，sha256 去重）。**无需停服，幂等**（已迁行自动跳过），趁旧桶未销毁尽快跑：
```bash
docker exec qiji-server node /app/server/scripts/migrate-fav-shared.mjs
docker exec qiji-server node /app/server/scripts/migrate-fav-shared.mjs --apply
docker exec qiji-server node /app/server/scripts/migrate-fav-shared.mjs --apply --limit=100   # 限量试跑
```
失败项如实列出：旧对象 404=只能等用户本地恢复；网络错误重跑补齐。

### D. 修 `.bin` 后缀存量（fix-octet-assets.mjs）

魔数嗅探真实类型 → PUT 新键（后缀换真实 ext + 正确 ContentType）→ 更新台账；**旧对象保留不删**（已下发的旧直链继续可用）：
```bash
docker exec qiji-server node /app/server/scripts/fix-octet-assets.mjs
docker exec qiji-server node /app/server/scripts/fix-octet-assets.mjs --apply
docker exec qiji-server node /app/server/scripts/fix-octet-assets.mjs --apply --id=video00024621
```

### E. 清理开闸推进节奏：off → dry → on(tmp) → on(all)

前提：先跑 B 的 `reconcile.mjs --apply` 回填 size（否则报告的「释放容量」偏低）；且确认是**新桶语境**（旧桶语境的清理已被用户令搁置，勿开启）。全程在管理端「存储」页「清理执行」卡操作：

1. **off → dry**：拨「试运行」。⚠ mode 首次离开 off（含 dry）即自动执行**存量特赦**（幂等一次）：全部「从未引用」的正式资产 last_ref_at=当日；ref 档 <30 天时抬到 30 并记 refBefore。TP 刻意不特赦。
2. **观察 dry 报告一至两天**：卡片「最近执行」表或 `GET /admin-api/cleanup`（报告落 `data/cleanup-report.json`，留 40 轮）。dry 只记报告零删除零墓碑。
3. **dry → on + scope=tmp**：拨「正式删除 · 仅临时资产 TP」。每轮 ≤2000、每小时一轮，最老的先删；可点「立即执行一轮」手动驱动。
4. **观察几天无用户反馈 → scope=all**：拨「全部档位」。
5. **满 30 天**：把「被引用」档天数从 30 调回 refBefore（卡片有天数提醒，需运营手动）。
6. 任何时刻拨回 off 即中止（下轮定时器直接跳过）。

## 验证

- **新档生效**（客户端传一张图后）：管理端「存储」页容量总览的存活/占用按「新 OSS」口径增长；台账新行 `storage`=新档 id、`oss_key` 形如 `<账号>/image/<yyyy>/<mm>/<dd>/<id>.png`。
- **公网直链可读**（Git Bash / Linux bash）：
  ```bash
  curl -sS -o /dev/null -w "%{http_code}" "https://<bucket>.<host>/<oss_key>"
  ```
  PS 5.1 等价（curl 在 PS 5.1 是 Invoke-WebRequest 别名，勿混用语法）：
  ```powershell
  (Invoke-WebRequest -Uri "https://<bucket>.<host>/<oss_key>" -Method Head -UseBasicParsing).StatusCode
  ```
- **只读校验**：`docker exec qiji-server node /app/server/scripts/verify.mjs`（退出码 0=干净 / 1=有告警 / 2=有错误）。
- **管理端 API**（Linux bash，服务器本机；端口按实际部署）：
  ```bash
  curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8787/admin-api/storage/stats
  curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8787/admin-api/retention
  curl -s -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8787/admin-api/cleanup
  ```
  本机 dev 用 PS 5.1：`Invoke-RestMethod -Uri "http://localhost:8787/admin-api/cleanup" -Headers @{Authorization="Bearer <ADMIN_TOKEN>"}`。
- **迁移收敛**：migrate-fav-shared 重跑候选归零；「旧桶遗留」格（bridgeCount）随桥接恢复/迁移逐步下降。
- **清理正确性**：报告 `deleted/failed/noKey` 自洽；被删行 `purged_at` 非空但 `url/oss_key` 仍在；收藏/共享库素材绝不出现在候选。

## 踩坑红线

- ⚠ **retention.ts 只算不删**——该模块没有删除能力是有意设计（P2 观察期约束延续），勿给它加删除；真删只在 cleanup.ts，且两边共用 `listSweepCandidates`。
- ⚠ **cleanup 三道闸勿绕过**：默认 off=部署后不动就零动作；推进只按 off→dry→on(tmp)→on(all)。第 223 轮清理在旧桶语境被用户令搁置——勿在旧桶上开启。
- ⚠ **台账行与 url/oss_key 永不删**：`reputAsset` 死链自愈、引用上报 needHeal 都依赖行存在；清理只打 `purged_at` 墓碑。
- ⚠ **删失败不打墓碑**（ossDeleteStrict）：吞错照打墓碑=对象还占容量却从统计消失；失败行下轮自动重试。
- ⚠ **删对象前必查 `ossKeyRefCount`**：sha256 去重后多行共享同一物理对象，引用数 >1 只打墓碑不删对象（cleanup 已内置该护栏，写新删除路径时同样必须带）。
- ⚠ **删除/自愈按行自己的 `storage` 档定位**（`profileOf(row.storage)`），用 active 档会删到/传到新桶上。
- ⚠ **cleanup 状态在独立 `data/cleanup.json`，勿并进 settings.json**——settings.ts 持启动快照覆写自有键，历史上发生过「启动后写入的键被旧快照抹掉」事故。
- ⚠ **SQL 类型陷阱**：`created_at` 是 TEXT ISO 串，`last_ref_at`/`purged_at` 是 INTEGER epoch 秒——混着比恒为 false，「从未引用」档会静默一个都清不掉。created_at 一律与 ISO 串比较。
- ⚠ **旧桶行不进候选、不进新 OSS 统计口径**（url 命中 ossBridgeOldBases）：其生命周期归桥接恢复语义管，清理删不到旧桶对象、打墓碑还碍统计。
- ⚠ **TP 不特赦**；存量特赦幂等（amnestyAt 有值永不重跑），首次拨离 off（含 dry）即触发。
- ⚠ **对账脚本必须在服务器上对实时台账跑**——对下载的静态 db 快照跑会把快照后的正常对象全判成孤儿（踩过）。
- ⚠ **孤儿补台账必须同步抬 `asset_seqs`**（reconcile.mjs 已内置），否则会分配出重复资产 id。
- ⚠ **对象键仅 ASCII、一旦分配永不改**；fix-octet-assets 换键=写新对象，旧对象保留不删。
- ⚠ **编辑 settings.json 加新档/改 active 后必须 `docker compose restart`**（保守口径：settings.ts 持启动快照，热改有被覆写风险）。
- ⚠ **PS 5.1 `-Encoding utf8` 写出的 settings.json 带 BOM** → 服务端 `JSON.parse` 静默失败=「OSS 未配置」假象。本地沙盒测试写 JSON 用 Node 落盘或 `[IO.File]::WriteAllText`（无 BOM）；服务器上用 vi/1Panel 编辑器。
- ⚠ **运维脚本结尾用 `process.exitCode`，勿用 `process.exit()`**（Windows 带未决句柄硬退偶发 0xC0000409）。
- ⚠ **`/opt/qiji` 在宿主机上未必存在**——那是 1Panel 显示的容器内路径；宿主机找 data 目录用 `docker inspect qiji-server` 查 Mounts。

## 相关文件

| 用途 | 路径（相对项目根） |
|---|---|
| 存储档解析（profile/layout/active） | `server\src\store\storage.ts` |
| S3 客户端多档缓存（ossPut/ossDelete/ossDeleteStrict/ossPresignPut/ossPublicUrl） | `server\src\store\oss.ts` |
| 资产台账（reputAsset 桥接自愈 / ossBridgeOldBases / sha256 去重 / ossKeyRefCount） | `server\src\store\assets.ts` |
| 保留策略三档，**只算不删**（listSweepCandidates / sweepPreview） | `server\src\store\retention.ts` |
| 清理执行，三道闸 off/dry/on + 存量特赦 | `server\src\store\cleanup.ts` |
| 存储档 / 旧桶基址 / 保留天数 配置落点 | `server\data\settings.json` |
| 清理状态 / 执行报告（独立文件） | `server\data\cleanup.json`、`server\data\cleanup-report.json`（运行时生成，首次拨离 off 前不存在） |
| 台账 ↔ 桶对账（size 回填/墓碑/孤儿补登） | `server\scripts\reconcile.mjs` |
| 只读校验（退出码 0/1/2） | `server\scripts\verify.mjs` |
| 结构迁移（补列建索引，幂等） | `server\scripts\migrate-p0.mjs` |
| `.bin` 后缀/octet-stream 存量修复 | `server\scripts\fix-octet-assets.mjs` |
| 收藏/共享库素材搬新桶 | `server\scripts\migrate-fav-shared.mjs` |
| 脚本公共库（零 src 依赖是刻意设计） | `server\scripts\_p0lib.mjs` |
| P0 存储运维手册（脚本详细说明） | `server\scripts\README-P0.md` |
| 管理端存储页与端点（/admin-api/retention、/admin-api/cleanup(+/run)、/admin-api/storage/stats） | `server\src\routes\admin.ts`、`server\src\admin\index.html` |
| 存储改造总方案（P0–P5，表结构/分阶段计划） | `docs\存储与数据结构改造方案.md` |
