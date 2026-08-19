---
name: qiji-brand-customization
description: "更换 Qiji 客户端与两控制台的品牌资产（logo、应用图标、窗口标题、品牌蓝 #6890F8）并重新打包/部署。触发词：换品牌、改 logo、换图标、品牌定制、改品牌色、白标、改窗口标题、换成 XX 品牌。红线：技术标识（productName/identifier）绝不能动。"
---

# Qiji 品牌定制与重新打包

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。下文路径与命令均相对项目根；命令除特别标注外在 **PowerShell 5.1** 执行（不支持 `&&`，多命令分行或用 `;`）。

## 何时使用

- 更换品牌 logo / 应用图标 / 窗口标题 / 控制台品牌字样（当前品牌为「灵创工场」，第 135/136 轮接入）。
- 调整品牌蓝 `#6890F8` 或整体换色。
- 白标定制：给渠道商出一版换皮客户端。
- **不适用**：改 `productName`、`identifier`、CSS 类名、localStorage 键——这些是技术标识，见「踩坑红线」第 1 条，任何品牌需求都不构成改它们的理由。

## 前置检查

```powershell
# ① 品牌源图在位（4 张，全部透明底 PNG）
ls "资料\品牌"
# 应见：logo-横版全称-原图.png / logo-图标-品牌蓝-透明底.png / logo-图标-黑-原图.png / 应用图标源-1024.png

# ② 客户端品牌资产与图标目录在位
ls "src\assets\brand"      # logo-full.png（登录页）、logo-mark.png（标题栏）
ls "src-tauri\icons"       # icon.ico / icon.icns / 32x32 / 128x128 / 128x128@2x / Square* / android / ios

# ③ 项目自带 ffmpeg 在位（图片处理一律用它，不装外部工具）
ls "src-tauri\resources\ffmpeg\ffmpeg.exe"

# ④ 技术标识基线留档（改完后对照，两值必须一字不变）
Select-String -Path "src-tauri\tauri.conf.json" -Pattern "productName|identifier"
# 期望：productName = "Qiji"、identifier = "com.qiji.canvas"
```

## 步骤

### 1. 处理源图（ffmpeg，可选）

源图是**透明底 PNG**（白色只是预览背景）。历轮（第 135 轮）用项目自带 ffmpeg 做按内容 bbox 裁剪与 alphaextract/alphamerge 上色。常用操作：

```powershell
# 查看图片流信息，确认 rgba（带透明通道）——ffmpeg 信息走 stderr、无输出文件报错属正常，看头部即可
& ".\src-tauri\resources\ffmpeg\ffmpeg.exe" -i "资料\品牌\logo-图标-品牌蓝-透明底.png"

# 等比缩放示例（-1 表示按比例自适应；目标尺寸按替换对象现状定，勿凭空指定）
& ".\src-tauri\resources\ffmpeg\ffmpeg.exe" -y -i "资料\品牌\logo-横版全称-原图.png" -vf "scale=-1:128" "C:\tmp\logo-new.png"
```

### 2. 替换客户端品牌资产

文件名保持不变（代码按文件名 import，改名要连改引用点）：

```powershell
Copy-Item "<新横版全logo>.png" "src\assets\brand\logo-full.png" -Force   # 登录页 LoginPage.tsx 引用
Copy-Item "<新方形mark>.png"   "src\assets\brand\logo-mark.png" -Force   # 标题栏 TitleBar.tsx 引用
```

### 3. 重生成应用图标

以 1024 方形源图（如 `资料\品牌\应用图标源-1024.png` 的替代品）重生成 `src-tauri\icons\` 全套。Tauri 2 CLI 自带 icon 命令（会整目录覆盖，含 android/ios 子目录，先备份）：

```powershell
Copy-Item "src-tauri\icons" "src-tauri\icons.bak" -Recurse       # 备份
npm run tauri -- icon "资料\品牌\应用图标源-1024.png"             # 生成全套（本 skill 未实跑，报错时 npx tauri icon --help 查用法）
ls "src-tauri\icons"                                              # 核对 icon.ico/icon.icns/各尺寸 png 均已更新
```

`tauri.conf.json` 的 `bundle.icon` 清单引用的是固定文件名（32x32/128x128/128x128@2x/icon.icns/icon.ico），文件名不变即无需改配置。

### 4. 窗口标题（tauri.conf.json）

只改 `app.windows[0].title`（当前为 `"灵创工场"`）这一处。**同文件的 `productName`、`identifier`、`additionalBrowserArgs`、`csp` 一律不碰**（后两者是打包红线，见 qiji-pack-client-tauri skill）。

### 5. 两控制台 HTML（title / favicon / 侧栏 / 登录卡）

两个文件是巨型单页（admin 约 3700 行、agent 约 1500 行），**不要整读**，用 Grep 定位后精准编辑：

| 文件 | 改动点（本次实测行号，可能漂移，以 grep 为准） |
|---|---|
| `server\src\admin\index.html` | 第 6 行 `<title>灵创工场 · 管理端控制台</title>`；第 7 行 `<link rel="icon"...>`（mark 图 data-URI）；侧栏品牌块；SMTP 占位文案（约 3678/3694 行含「灵创工场」） |
| `server\src\agent\index.html` | 第 6 行 `<title>灵创工场 · 渠道商控制台</title>`；favicon；侧栏白底磁贴 + mark 图 +「灵创工场」；登录卡横版全 logo |

定位命令（Claude 用 Grep 工具同理）：

```powershell
Select-String -Path "server\src\admin\index.html","server\src\agent\index.html" -Pattern "灵创工场" | Select-Object Path, LineNumber
```

新 logo 要嵌入 HTML 时转 base64 data-URI（沿用现状做法，控制台是自包含单页不引外部资源）。

### 6. 品牌色 #6890F8

现有引用（本次 grep 实锤）：`src\components\AssetAssistant.tsx`（2 处：扩容文案色、配额进度条色）、`src\components\TaskRecoveryNotice.tsx`（1 处：图标色）。换色时全库 grep 兜底：

```powershell
# PS 5.1 无 ** globstar，必须 Get-ChildItem -Recurse（Claude 会话里可直接用 Grep 工具，天然递归）
Get-ChildItem src -Recurse -Include *.tsx,*.ts,*.css | Select-String -Pattern "6890F8" -AllMatches
```

### 7. 打包与部署

- **客户端改动**（步骤 2/3/4/6）→ 走 `qiji-pack-client-tauri` skill 重新打包（`npm run build` + `npm run tauri build`，含三个内置二进制核验）。
- **控制台改动**（步骤 5）→ 先跑 `qiji-preflight-check` 的 admin/agent script 语法校验，再走 `qiji-pack-and-deploy-server` skill 重新部署服务端。
- 两侧都改了就两个都做；收口时按 `qiji-round-log-update` 记 CLAUDE.md。

## 验证

```powershell
# ① 技术标识零变化（两行输出与前置检查 ④ 逐字一致）
Select-String -Path "src-tauri\tauri.conf.json" -Pattern "productName|identifier"

# ② 双击 logo 隐蔽入口仍在（须有 onDoubleClick 命中）
Select-String -Path "src\canvas\LoginPage.tsx" -Pattern "onDoubleClick"

# ③ 品牌字样替换无遗漏（改品牌名时旧名应零命中；只换图不换名则跳过）
Select-String -Path "server\src\admin\index.html","server\src\agent\index.html" -Pattern "<旧品牌名>"

# ④ 客户端构建过
npm run build
```

- 控制台 HTML 改动的语法校验与 dist 产物实锤走 `qiji-preflight-check`（admin HTML 白屏坑 tsc 抓不到，必做）。
- 打包后真机核对：窗口标题、任务栏/桌面图标、登录页横版 logo、标题栏 mark、双击登录页 logo 能展开服务器地址栏。
- 部署后强刷两控制台：浏览器标签 title 与 favicon、侧栏品牌、门户登录卡。

## 踩坑红线

1. ⚠ **最重红线：全局替换品牌时不动技术标识**——`productName: "Qiji"`、`identifier: "com.qiji.canvas"`、CSS 类名 `Qiji-*`、localStorage 键（`Qiji:` 前缀，src 下 14 个文件在用；改前先 grep `Qiji:` 现查清单）。**改 identifier = 换 appData 目录 = 用户数据全丢**（第 135 轮定稿）。做全局查找替换时必须把这四类排除在外。
2. ⚠ **LoginPage.tsx 双击 logo 显示服务器地址栏的隐蔽入口勿删**（第 225 轮：服务器地址栏默认隐藏，双击 logo 展开是渠道商节点用户/运维改地址的唯一入口；代码注释原文即带「勿删」，本次实测在 176–185 行附近，`onDoubleClick={() => setShowServer(...)}` 挂在 `logoFull` 的 `<img>` 上——换图时保留该属性）。
3. ⚠ **源图是透明底 PNG，白色只是预览背景**——别当白底图处理、别给它加白底；图片处理用项目自带 `src-tauri\resources\ffmpeg\ffmpeg.exe`，不引外部工具。
4. ⚠ **改了 admin/agent HTML 必做 script 语法校验**（`qiji-preflight-check`）——巨型内嵌 `<script>` 出语法错=控制台整页白屏，tsc 完全覆盖不到。
5. ⚠ **控制台品牌改动须重新部署服务端；客户端资产/图标/标题改动须重新打包客户端**——只做一半就是两端品牌不一致。
6. ⚠ **门户品牌 =「灵创工场 · 渠道商控制台」是第 136 轮用户定稿**（覆盖更早的「门户品牌=商名」方案），商名只保留在侧栏底部 `#me_name`——除非用户明确要求，不要把门户品牌改回商名。
7. ⚠ **动 tauri.conf.json 时别顺手碰 `additionalBrowserArgs` 与 CSP**——前者会整体替换 wry 默认参数、后者 `script-src` 缺 `blob:` 会让打包版 ONNX 全挂且 dev 复现不出（打包红线归 `qiji-pack-client-tauri` 管，此处只提醒别误伤）。

## 相关文件

| 用途 | 路径 |
|---|---|
| 品牌源图（4 张，透明底 PNG） | `资料\品牌\`（横版全称原图 / 图标-品牌蓝 / 图标-黑 / 应用图标源-1024） |
| 客户端横版全 logo（登录页） | `src\assets\brand\logo-full.png`（`src\canvas\LoginPage.tsx` import） |
| 客户端方形 mark（标题栏） | `src\assets\brand\logo-mark.png`（`src\canvas\TitleBar.tsx` import） |
| 应用图标全套 | `src-tauri\icons\`（icon.ico / icon.icns / 各尺寸 png / Square* / android / ios） |
| 窗口标题 + 打包配置 | `src-tauri\tauri.conf.json`（`app.windows[0].title`；productName/identifier 勿动） |
| 登录页（双击 logo 隐蔽入口） | `src\canvas\LoginPage.tsx` |
| 标题栏 | `src\canvas\TitleBar.tsx` |
| 管理端控制台品牌 | `server\src\admin\index.html`（title/favicon/侧栏；勿整读，Grep 定位） |
| 渠道商门户品牌 | `server\src\agent\index.html`（同上；品牌定稿注释约 362 行） |
| 品牌蓝 #6890F8 引用 | `src\components\AssetAssistant.tsx`、`src\components\TaskRecoveryNotice.tsx` |
| 图片处理工具 | `src-tauri\resources\ffmpeg\ffmpeg.exe` |
