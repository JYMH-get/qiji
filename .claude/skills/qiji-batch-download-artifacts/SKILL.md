---
name: qiji-batch-download-artifacts
description: 从 Qiji 请求记录导出产物下载清单（管理端「批量下载」页），用 qiji-downloader 独立 exe 批量下载/抢救上游原链产物。触发词：批量下载产物、抢救原链、导出下载清单、下载器、转存 OSS 失败的成片要补救、_failed.json 重跑。
---

# Qiji 产物批量下载 / 抢救

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）；正文路径均相对项目根。

## 何时使用

- 用户要把请求记录里的产物链接**批量下载到本地**（按时间/用户/类型/保存情况筛选）。
- **抢救上游原链**：服务端转存 OSS 失败时不整单报废（上游已扣费），会回退上游原链完成任务——这些产物**没有永久直链、也不在资产台账**（`rehosted:false` 分支的 `vid-<上游任务号>` 伪 id），只存在于请求记录的 `resultLink` 里。本 skill 就是把它们捞出来。
- 跑过一轮后要拿 `_failed.json` 只重试失败项。

已存 OSS 的产物有永久直链，用户自己能下——本流程主要针对「仅上游原链」。

## 两条硬约束（先看这个，红线之首）

1. ⚠ **上游原链有时效且很短**：各渠道 2 小时（简梦Z 图片）到 24 小时（火山、简梦F）不等。请求记录留 30 天，但隔夜原链多半已 404。
   → **这是抢救工具，不是归档工具**。导出清单后**立即**下载；清单按时间倒序（新的先出），工具按清单顺序抓；`expiryRisk: "expired"` 条目失败属**预期**，救不回来。
2. ⚠ **`authRequired: true` 的条目直连必然 401/403，别当 bug 排查**：简梦F、简梦Z 图片、出海营、Skylee 等渠道成片下载须带上游密钥，而密钥只在服务端、绝不外发。工具默认跳过并如实计入「需服务端代下」，**不做无谓重试**；要救这部分只能由服务端代下（该通道未做）。

## 前置检查

1. 下载器 exe 在位（约 838KB，单文件无运行时依赖）：

   ```powershell
   # PowerShell 5.1 / Git Bash 均可
   ls tools/downloader/target/release/qiji-downloader.exe
   ```

   不在则编译（需 Rust 工具链）：

   ```bash
   # Git Bash（PS 5.1 分两行跑，不能用 &&）
   cd tools/downloader && cargo build --release
   ```

2. 服务端可达且部署了第 232 轮之后的代码（`/admin-api/downloads/*` 端点在役）：

   ```bash
   # Git Bash（curl 在 PS 5.1 里是 Invoke-WebRequest 别名，勿混用）
   curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" "http://<服务端>/admin-api/downloads/summary" | head -c 300
   ```

   ```powershell
   # PowerShell 5.1 等价写法
   Invoke-RestMethod -Uri "http://<服务端>/admin-api/downloads/summary" -Headers @{ Authorization = "Bearer <ADMIN_TOKEN>" }
   ```

   回 404 = 服务端是旧包，先走 qiji-pack-and-deploy-server 部署。

## 步骤

### 1. 管理端导出清单

管理端 `/admin` →「批量下载」页（系统组）：

- 筛选：范围下拉（源站/某渠道商）+ 时间段 + 用户/步骤/模型 + **保存情况（默认「仅上游原链」——那才是要抢救的）** + 类型。
- 看 KPI 与三条自动告警（截断 / 已过期数 / 需代下数），心里有数再导。
- 点 **「导出清单 JSON（给下载器）」** 拿清单文件。

保存情况四态（`server/src/store/assetExport.ts` `classifyLink`）：
`oss`（新 OSS 直链）/ `oss-old`（旧桶已舍弃）/ `local`（未配 OSS 的 `/v1/assets/:id/raw` 兜底）/ `raw`（上游原链，抢救对象）。
`authRequired` 判定＝「raw 且结果域与该模型所属渠道 baseUrl 同域（含子域）」，与翻译器附 Bearer 的判据同构——**不是静态域名清单**，新接渠道自动覆盖。

清单上限 50000 条，超出 `truncated: true` 并报实际 `matched` 数——命中告警就缩小时间段分批导。

### 2. 独立下载器跑批

```powershell
# PowerShell 5.1；Git Bash 下路径须用正斜杠或加引号（如 --out "D:/Qiji产物"，否则反斜杠被 bash 吃掉、静默落错位置）
tools/downloader/target/release/qiji-downloader.exe --manifest 清单.json --out D:\Qiji产物
```

常用选项（默认值经 `tools/downloader/src/main.rs` 核实）：

| 选项 | 说明 |
| --- | --- |
| `--concurrency N` | 并发数（默认 4，上限 16） |
| `--retries N` | 每文件重试次数（默认 2） |
| `--timeout N` | 单文件超时秒（默认 600——成片可能几百 MB） |
| `--overwrite` | 覆盖已存在文件（默认跳过，重跑只补缺） |
| `--raw-only` | 只下上游原链（storage=raw） |
| `--include-blocked` | 连「需服务端代下」的也试（基本 401，慎用） |
| `--dry-run` | 只列计划不下载 |

落盘按清单建议路径分目录：`<用户>/<日期>/<步骤>_<日志ID>[_序号].<扩展名>`。

### 3. 失败重跑

失败清单写在 `<目标目录>/_failed.json`，**格式与输入清单完全相同**——直接当 `--manifest` 再跑一次即只重试失败项：

```powershell
tools/downloader/target/release/qiji-downloader.exe --manifest D:\Qiji产物\_failed.json --out D:\Qiji产物
```

| 失败现象 | 含义 |
| --- | --- |
| HTTP 404/403 且 `expiryRisk=expired` | 原链已过期，救不回 |
| `需服务端代下` | 须带上游密钥，本工具拿不到 |
| `请求失败：...timed out` | 网络问题，重跑通常就好 |

### 其他消费端（备选）

- 管理端页内「浏览器直下」：**≤50 条**且不分目录，只适合小批量。
- 渠道商门户「批量下载」页：范围恒本商（`/agent-api/downloads/manifest|summary`）。
- 客户端个人中心「批量下载」页签：**仅 Tauri 打包版可用**（原生命令 `download_to`），引擎在 `src/services/batchDownload.ts`。

## 验证

1. 下载器退出码：**有失败时非 0**（脚本可判）；结尾统计行有 成功/跳过/需代下/失败 计数。
2. 目标目录无 `.part` 残留（先写 `.part` 完成才 rename——有残留=中断，重跑即补）。
3. `_failed.json` 逐条核对失败原因是否都属上表三类预期；`expired` 与 `需服务端代下` 之外的大量失败才值得排查。
4. 抽查文件能打开、目录结构为 `<用户>/<日期>/`。

## 踩坑红线

- ⚠ **原链 2–24 小时过期**（红线之首，见上「两条硬约束」）——导出清单后立即下载，别隔夜；`expired` 失败属预期。
- ⚠ **`authRequired` 条目直连必然 401/403**——工具默认跳过是设计行为，别当 bug 排查、别指望 `--include-blocked` 能救（密钥只在服务端）。
- ⚠ **清单数据源是请求记录不是资产台账**——转存失败回退原链的产物压根不入台账，别去 assets 表找。
- **`_failed.json` 与输入清单同格式，可直接当输入重跑**——别手写脚本二次加工。
- 防目录穿越：清单里含 `..` 段的路径会被剔除（手改清单时注意，绝不写出目标目录之外）。
- 重跑默认跳过已存在文件（`.part` 机制保证「已存在=完整」），想强制重下才加 `--overwrite`。
- 归属隔离由端点入口强制（门户恒本商、用户端恒本人），查询串塞别人的 userIds 无效——别试图从门户/客户端拉全量清单，全量走管理端。
- PS 5.1 不支持 `&&`；`curl` 在 PS 5.1 是 Invoke-WebRequest 别名——带 header 的接口探测用 Git Bash 或 `Invoke-RestMethod`。

## 相关文件

| 用途 | 路径 |
| --- | --- |
| 下载器 crate + 使用文档（两条硬约束原文） | `tools\downloader\`、`tools\downloader\README.md` |
| 下载器 exe（release 产物） | `tools\downloader\target\release\qiji-downloader.exe` |
| 下载器实现（选项默认值/防穿越/`.part`） | `tools\downloader\src\main.rs` |
| 清单生成：classifyLink 四态 / authRequired / expiryRisk / 建议路径 | `server\src\store\assetExport.ts` |
| 管理端端点 `/admin-api/downloads/manifest|summary` | `server\src\routes\admin.ts` |
| 门户端点 `/agent-api/downloads/manifest|summary` | `server\src\routes\agent.ts` |
| 用户端点 `/v1/downloads/manifest` | `server\src\routes.ts` |
| 管理端「批量下载」页 / 门户同款页 | `server\src\admin\index.html`、`server\src\agent\index.html` |
| 客户端下载引擎（个人中心「批量下载」页签，仅 Tauri） | `src\services\batchDownload.ts` |
