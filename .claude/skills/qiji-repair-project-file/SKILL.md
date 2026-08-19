---
name: qiji-repair-project-file
description: 修复损坏的 .Qiji 项目文件：先判定损坏类型（截断+NUL / 整体 NUL），再用 scripts/repair-qiji.mjs 选 flags 修复，解读退出码 0/2/1，最后客户端打开验证。触发词：项目打不开、项目文件损坏、修复 .Qiji、文件全是 NUL、项目文件异常巨大（上百 MB）。
---

# qiji-repair-project-file —— 修复损坏的 .Qiji 项目文件

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。正文路径均相对项目根。
> 定位：`scripts/repair-qiji.mjs` 已把修复知识完整固化（头部注释即文档），本 skill 只做薄封装——判据 → 选 flags → 读退出码 → 验证。

## 何时使用

- 用户报「项目打不开 / 加载报损坏 / 客户端弹恢复失败」，且 `.tmp`/`.bak` 自动恢复（客户端内置，projectStore.ts）也没救回来。
- 项目文件体积异常（几十到几百 MB）——genMeta/assetRefImages 落盘 base64 膨胀（CLAUDE.md §7.1），写盘窗口被拉长、中断即截断。
- 历史两例背景（脚本头注释与 CLAUDE.md 第80/99轮均有记载）：161MB「三姐妹」（前约 1MB 有效）、38MB「锁妖塔」（前约 4MB 有效、截断落在 commits 内→靠投影反推救回业务数据）。

两类损坏（均源于「写 tmp → 轮换 .bak → rename」原子保存被中断）：
1. **截断 + NUL**：前半段合法 JSON、后半段被 `\x00` 填满（只落了前一段）→ 可救回最长合法前缀。
2. **整体 NUL**：文件占了空间但内容一个字节没落盘（全 `\x00`）→ 本体无可恢复，只能找兄弟文件/备份。

## 前置检查

1. **拿到损坏文件路径**。客户端项目默认在 `%APPDATA%\com.qiji.canvas\Qiji\projects\<项目名_时间戳>\project.Qiji`；同目录留意 `project.Qiji.tmp`（已写完未改名的新版本）与 `project.Qiji.bak`（上一次完整保存）——它们常常就是完好答案。
2. **判定损坏类型（看头尾字节）**：

   PowerShell 5.1（单行直贴）：
   ```powershell
   $p = "C:\损坏文件完整路径\project.Qiji"; $fs = [IO.File]::OpenRead($p); $n = 16; $h = New-Object byte[] $n; [void]$fs.Read($h, 0, $n); [void]$fs.Seek(-$n, 'End'); $t = New-Object byte[] $n; [void]$fs.Read($t, 0, $n); $fs.Close(); "头16字节: $($h -join ' ')"; "尾16字节: $($t -join ' ')"
   ```
   （文件小于 16 字节时该命令会因 Seek 越界报错——这种情况本体必然没内容，直接跳到步骤 2 跑脚本即可。）

   Git Bash 等价：
   ```bash
   head -c 16 "project.Qiji" | od -An -tx1; tail -c 16 "project.Qiji" | od -An -tx1
   ```

   判读：头以 `123`（十进制）/`7b`（`{`）开头 + 尾全 0 → **截断+NUL**；头就是全 0 → **整体 NUL**；头 `{` 尾非 0 → 可能只是半截字段/编码问题，直接跑脚本（它会先试直接 JSON.parse）。
3. `node --version` 确认 Node 可用（脚本零依赖，`node:fs`/`node:path` 内置模块直跑）。

## 步骤

### 1. 默认参数先跑一次（两类损坏都从这里开始）

在项目根 `E:\Kaifa\Qiji\qiji` 下执行（PowerShell 5.1 / Git Bash 通用，无 &&、无内嵌引号问题）：

```powershell
node scripts/repair-qiji.mjs "C:\损坏文件完整路径\project.Qiji"
```

脚本自己判类型并打印 `读取: X MB，有效内容 N 字符`；默认输出**同目录 `<名>-修复.Qiji`**（不动原件）。

### 2. 按需选 flags（以脚本实际实现为准，已逐一核实）

| flag | 作用 | 何时用 |
|---|---|---|
| `--out <路径>` | 指定输出文件 | 想把修复件放到别处 |
| `--no-slim` | 不剥 base64 大字段 | 极少用；默认瘦身会把 genMeta/assetRefImages/assetBlobs 里 `data:`/`blob:` 且 >512 字符的字段置空（显示层会自愈重取），保留原始体积才加它 |
| `--no-sibling` | 本体不可修复时不找兄弟文件代修 | 同目录兄弟文件（`.Qiji`/`.tmp`/`.bak`，按文件名词干匹配、排除「修复/corrupt」命名）不是同一项目时 |
| `--inplace` | 原地覆盖原件 | 覆盖前自动备份为 `<名>.corrupt-<时间戳>`；一般不用，默认另存更稳 |
| `--quiet` | 少打印 | 批量处理时 |

### 3. 读退出码

| 退出码 | 含义 | 下一步 |
|---|---|---|
| **0** | 修复成功（含修复件回读 JSON.parse 校验通过） | 进「验证」 |
| **2** | 本体不可修复（全 NUL 或解析不出任何合法结构），且兄弟文件也救不回/被 `--no-sibling` 关掉 | 找云同步、微信/QQ 传过的副本、其它设备备份，对副本重跑脚本 |
| **1** | 参数/IO 错误（无参数、文件不存在），或修复件回读校验失败（罕见） | 核对路径重跑；回读失败则把报告全文留档排查 |

### 4. 读修复报告（脚本 stdout）

- `解析方式`：`direct`（无损）/ `truncate-close`（闭合截断 JSON，丢弃尾部半截字段，通常是膨胀的 genMeta）/ `truncate-close-retry`。
- `数据来源: xxx（本体全损，用兄弟文件代修）`：整体 NUL 时自动改修兄弟文件的标记。
- `投影反推`：截断落在 commits 内、顶层业务字段全丢时，从画布投影节点（sourceRef=script/episode:/shot:/shotSb:/shotVid:/asset:，语义依据 src/services/canvasProjection.ts）反推 剧本全文/五类资产/分集/分镜——「锁妖塔」即靠这条路救回。
- `瘦身剥离: N 处 base64（约 X MB）` 与 `内容概要`（剧本字数/角色/场景/物品/生物/群像/分集/分镜/提交数）。

## 验证

1. 退出码 0 且报告末行 `回读校验: ✓ 合法 JSON`。
2. `内容概要` 与用户记忆对照：剧本字数、资产数、分集/分镜数应非零且量级合理——修复件体积远小于原件属**预期**（紧凑序列化+剥 base64），别按体积判丢数据。
3. **客户端打开验证**：客户端大厅「导入已有项目 (.Qiji)」选修复件（导入=复制为新项目、源文件分毫不动，第173轮语义），逐项检查 剧本原文、五类资产、分集分镜、画布节点。
4. 被瘦身置空的图片/视频引用由显示层自愈重取（本机有副本或 OSS 对象仍在即恢复）；确认关键资产图能显示。
5. 验证通过后再考虑清理原损坏件（建议保留 `.corrupt-*` / 原件一段时间）。

## 踩坑红线

- ⚠ **默认另存，勿急删原件**：修复件是 `<名>-修复.Qiji`；即便 `--inplace` 有 `.corrupt-<时间戳>` 自动备份，也要等客户端验证通过再清理。
- ⚠ **原子保存/兜底恢复机制在 `src/store/projectStore.ts`，不在 `src/services/projectFile.ts`**（前期清单记载有误）：save()=写 `.tmp` → fsync 刷盘 → 轮换 `.bak` → rename；loadFromPath() 依次试 `.tmp`/`.bak` 恢复。排查保存链路别找错文件；fsync 是防「断电主文件与 .bak 双清零」的实测教训，勿删。
- ⚠ **全 NUL 没有奇迹**：内容从未落盘，反复跑脚本无意义——出路只有同目录 `.tmp`/`.bak` 兄弟（脚本默认自动找）与外部副本。
- ⚠ **`--no-slim` 慎用**：内联 base64 正是百 MB 膨胀与二次损坏的根源（CLAUDE.md §7.1，161MB 事故根源）；保留它=修复件继续巨大、下次保存窗口继续被拉长。
- ⚠ **命令环境纪律**：PowerShell 5.1 不支持 `&&`（分号或分两条跑）；含内嵌双引号的 `node -e` 单行在 PS 5.1 必挂（内嵌引号被剥）——本流程刻意不需要 `node -e`（脚本自带回读校验）；真要写临时校验脚本，先落成 `.mjs` 文件再 `node xxx.mjs`。退出码：PS 用 `$LASTEXITCODE`，Git Bash 用 `echo $?`。
- ⚠ **绝不整读 CLAUDE.md**（502KB 撑爆上下文）：查事故史/机制记载用 Grep 带 head_limit 精准查（如关键词「三姐妹」「锁妖塔」「原子保存」）。

## 相关文件

| 用途 | 路径 |
|---|---|
| 修复工具（头部注释=完整文档，flags/退出码权威来源） | `scripts\repair-qiji.mjs` |
| 原子保存（tmp→.bak→rename+fsync）与 .tmp/.bak 兜底恢复 | `src\store\projectStore.ts` |
| 项目文件类型定义与读写 IO（loadProjectFromPath 等） | `src\services\projectFile.ts` |
| assetBlobs 载入清洗（sanitizeAssetBlobs） | `src\lib\blobSanitize.ts` |
| 画布投影节点语义（脚本「投影反推」的依据） | `src\services\canvasProjection.ts` |
| 事故史与机制记载（第79/80/99/173轮、§7.1、§9）——只 Grep 勿整读 | `CLAUDE.md` |
