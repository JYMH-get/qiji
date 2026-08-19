---
name: qiji-pack-client-tauri
description: 打包 Qiji 桌面客户端（Tauri 2）并核验产物。触发词：打包客户端、客户端发版、重新打包、出安装包、tauri build、换机/首次打包。涵盖 fetch 三个内置二进制、DEFAULT_SERVER_URL 产物实锤与四条打包红线。
---

# Qiji 客户端打包发版（Tauri 2）

> 项目根：`E:\Kaifa\Qiji\qiji`（其他设备以实际 clone 位置为准）。下文所有相对路径均相对该项目根。
> 技术栈：Vite 5 + React 18 + Tauri 2；`npm run build` = `tsc -b && vite build`。

## 何时使用

- CLAUDE.md 本轮变更记录标注「**须客户端重新打包**」时（约每 3–5 轮一次发版）。
- 换机 / 首次 clone 后要出安装包。
- 改动了 `src-tauri/`（Rust、tauri.conf.json、capabilities、icons、resources）后发版。
- ⚠ 若本轮同时标注「须重新部署服务端」，打包与服务端部署要配套发（见步骤 5）。

## 前置检查

1. **三个内置二进制在位**（约 186MB，不入 git；缺任一则打出的包缺原生能力）：
   - `src-tauri/resources/ffmpeg/ffmpeg.exe`（约 97MB）
   - `src-tauri/resources/libtv/libtv.exe`（约 58MB）
   - `src-tauri/resources/dreamina/dreamina.exe`（约 31MB）

   本机 PowerShell 5.1（⚠ 不支持 `&&`，用分号或分行）：
   ```powershell
   Get-ChildItem E:\Kaifa\Qiji\qiji\src-tauri\resources -Recurse -File | Select-Object FullName, Length
   ```
   缺哪个就跑对应 fetch 脚本（幂等：已存在即跳过，删掉 exe 重跑=更新版本）。本机 PowerShell 5.1，在项目根执行：
   ```powershell
   powershell -ExecutionPolicy Bypass -File src-tauri/scripts/fetch-ffmpeg.ps1
   powershell -ExecutionPolicy Bypass -File src-tauri/scripts/fetch-libtv.ps1
   powershell -ExecutionPolicy Bypass -File src-tauri/scripts/fetch-dreamina.ps1
   ```

2. **内置深度模型在位**（随包分发，安装包 +45MB）：`public/depth-model/onnx-community/depth-anything-v2-small/` 下应有 4 个文件（config.json / preprocessor_config.json / onnx/model_q4f16.onnx 约 19MB / onnx/model_quantized.onnx 约 26MB）。

3. **仓库根无 `vite.config.js` 残留**（红线 3，只能有 `vite.config.ts`）。本机 PowerShell 5.1：
   ```powershell
   Test-Path E:\Kaifa\Qiji\qiji\vite.config.js   # 必须为 False
   ```

4. **确认 `DEFAULT_SERVER_URL` 分支**：`src/store/connectionStore.ts:18`
   ```ts
   export const DEFAULT_SERVER_URL = import.meta.env.DEV ? "http://localhost:8787" : "http://103.120.91.71:8787";
   ```
   dev 走本机 8787 防误连生产；打包版硬编码生产服务器。⚠ 换服务器/上域名时**只改这一处**（第225轮定稿；第226轮起客户端启动一律钉回默认地址，双击登录页 logo 才能临时改）。

5. **本轮自检已过**（qiji-preflight-check 范畴，最低限度）。本机 PowerShell 5.1，在项目根：
   ```powershell
   npx tsc --noEmit
   npx vitest run     # 参考基线：602 passed（以 CLAUDE.md 最新轮次为准）
   ```
   动过 `src-tauri/src/lib.rs` 或 Cargo.toml 时另跑：
   ```powershell
   cd src-tauri; cargo check
   ```

## 步骤

在项目根 `E:\Kaifa\Qiji\qiji` 执行。

1. **前端构建**。本机 PowerShell 5.1：
   ```powershell
   npm run build
   ```

2. **grep dist 实锤 DEFAULT_SERVER_URL 打包分支**（第225轮验证做法，构建后必做）。本机 Git Bash：
   ```bash
   cd /e/Kaifa/Qiji/qiji
   grep -l "103.120.91.71:8787" dist/assets/*.js   # 应命中至少一个文件（打包分支在）
   grep -l "localhost:8787" dist/assets/*.js       # 应无输出（DEV 分支被摇树）
   ```
   或本机 PowerShell 5.1：
   ```powershell
   Select-String -Path dist\assets\*.js -Pattern "103\.120\.91\.71:8787" -List | Select-Object Filename
   ```
   若已换服务器地址，grep 目标同步换成新地址。

3. **Tauri 打包**（beforeBuildCommand 会再跑一次 `npm run build`，属预期）。本机 PowerShell 5.1：
   ```powershell
   npm run tauri build
   ```

4. **取产物**：`src-tauri/target/release/bundle/nsis/`（.exe 安装包）与 `src-tauri/target/release/bundle/msi/`（.msi）。

5. **分发前核对发版配套**：查 CLAUDE.md 本轮（及上次发版以来各轮）的标注——「须客户端重新打包 / 须重新部署服务端 / 两者」。多轮客户端改动通常攒到同一次发版；若有配套服务端改动，先走 qiji-pack-and-deploy-server 部署，再分发安装包。

## 验证

- 步骤 2 的 dist grep 双向通过（生产地址在、localhost 被摇树）。
- bundle 目录产出新时间戳的安装包。
- 真机装包冒烟：登录页**无**「服务器地址」栏（默认直连生产）、双击 logo 可展开地址栏；转深度可用（验证 CSP blob: 与 WebGPU 参数未被改坏）；视频截帧可用（验证 ffmpeg 随包）。
- 若改过 `src-tauri/capabilities/default.json` 或 lib.rs：真机验证多窗口（二次启动同 exe = 本进程新窗口 `main-*`）不回归。

## 踩坑红线（一条不能丢）

1. ⚠ **`additionalBrowserArgs` 会整体替换 wry 默认参数**——加 `--enable-features=WebGPU` 时必须把 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required` 一起带上。当前正确值见 `src-tauri/tauri.conf.json`（app.windows[0].additionalBrowserArgs），三段参数齐全才是对的。
2. ⚠ **CSP `script-src` 必须含 `blob:`**（否则打包版 ONNX Runtime 多线程路径全挂——转深度报「no available backend found」，且 dev 浏览器复现不出来）。当前 `tauri.conf.json` security.csp 的 script-src 已含 `'unsafe-inline' 'unsafe-eval' blob:`，勿删任一。
3. ⚠ **仓库根不能残留 `vite.config.js`**——vite 解析 `.js` 优先于 `.ts`，会静默遮蔽 `vite.config.ts` 的所有配置改动（第144轮事故：define/插件改动全部不生效）。tsc 误产出该文件时立即删除。
4. ⚠ **不要改 `productName`（Qiji）/ `identifier`（com.qiji.canvas）**——改 identifier = 换 appData 目录 = 用户数据全丢。品牌改名只动窗口标题 `app.windows[0].title`（现为「灵创工场」）与前端资产，技术标识（含 CSS 类名 `Qiji-*`、localStorage 键）一律不动。

## 相关文件

| 用途 | 路径 |
|---|---|
| 前端构建/打包脚本（build、tauri） | `package.json` |
| Tauri 配置（CSP、additionalBrowserArgs、bundle.resources、icons、标题） | `src-tauri/tauri.conf.json` |
| 打包版默认服务器地址（dev/打包分支，换服务器只改这一处） | `src/store/connectionStore.ts:18` |
| 拉取内置 ffmpeg（换机/首次打包必跑） | `src-tauri/scripts/fetch-ffmpeg.ps1` |
| 拉取内置 LibTV CLI | `src-tauri/scripts/fetch-libtv.ps1` |
| 拉取内置即梦 CLI | `src-tauri/scripts/fetch-dreamina.ps1` |
| 三个随包二进制落位目录 | `src-tauri/resources/{ffmpeg,libtv,dreamina}/` |
| 窗口权限（含多窗口 `main-*`、fs:allow-rename） | `src-tauri/capabilities/default.json` |
| 内置深度模型（安装包 +45MB） | `public/depth-model/onnx-community/depth-anything-v2-small/` |
| Rust 原生命令（ffmpeg 调用/下载/单实例多窗口） | `src-tauri/src/lib.rs`、`src-tauri/Cargo.toml` |
| 唯一有效的 vite 配置（.js 版属残留必删） | `vite.config.ts` |
| 安装包产物 | `src-tauri/target/release/bundle/{nsis,msi}/` |
| 每轮「须打包/须部署」标注与勿回退清单 | `CLAUDE.md`（502KB，只用 Grep 精准查，勿整读） |
