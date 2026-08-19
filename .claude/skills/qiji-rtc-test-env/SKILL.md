---
name: qiji-rtc-test-env
description: 启动【实时剪辑】模式（第235轮，/frame-editor）的测试环境并按清单冒烟：浏览器路径测 UI/时间轴/生成链路，Tauri 桌面路径测导出剪映草稿与本地素材。触发词：测试实时剪辑、实时剪辑测试环境、验证时间轴/剪辑模式、测导出剪映草稿、rtc 冒烟。
---

# qiji-rtc-test-env —— 实时剪辑模式测试环境与冒烟清单

> 项目根：`E:\Kaifa\Qiji\qiji`。实时剪辑=第235轮新增的第三模式（CLAUDE.md §8 第235轮 + §9A 前五条），代码集中在 `src\rtc\`，路由 `/frame-editor`，开关 `features.editorMode`（缺省=开）。
> 基础环境（清 tsx 僵尸 / 起 8787 服务端 / 起 5199 前端 / 健康检查）**全部沿用 skill `qiji-dev-env-start`**，本 skill 只写实时剪辑特有的部分。

## 何时使用

- 要人工或自动验证实时剪辑模式的任何功能（时间轴、资产拖入、分镜占位、AI 生成、预览、导出剪映草稿）。
- 第235轮「待真机 QA」清单逐项验收时。
- 改动 `src\rtc\**`、`src\lib\rtcOps.ts`、`src\store\rtcStore.ts`、`src\lib\jianyingDraft.ts`、`src\services\jianyingExport.ts` 或 `src-tauri\src\lib.rs` 的 jianying_* 命令之后。

## 两条测试路径怎么选

| 能力 | 浏览器路径（vite 5199） | 桌面路径（tauri dev） |
|---|---|---|
| 模式入口/三栏布局/时间轴拖裁分/吸附/undo | ✅ | ✅ |
| 资产面板/拖拽入轨/分镜占位/属性面板/AI 生成 | ✅ | ✅ |
| 顺序预览播放器 | ✅ | ✅ |
| **导出剪映草稿**（Rust jianying_* 命令） | ❌ 明确报「仅在桌面版可用」 | ✅ **只能在这测** |
| 本地素材落盘/项目文件持久化 | ❌（内存态） | ✅ |
| 多窗口 rtcDoc 同步 | 双标签页近似（BroadcastChannel） | ✅ 真多窗口 |

日常 UI/逻辑验证走浏览器路径（快）；导出与落盘必须走桌面路径。

## 步骤

### 1. 基础环境（按 `qiji-dev-env-start` 全套执行）

清 tsx 僵尸 → `preview_start` 起 `qiji-server`（8787）→ `/health` 200 → 起 `qiji-client`（5199，被占用 `qiji-client-b` 5233）。⚠ `server\data\` 是本机 dev 真实库，测试项目会真实写进用户数据目录——测完删测试项目。

### 2. 登录并进入实时剪辑

1. 浏览器开 `http://localhost:5199`，dev 前端自动直连 `localhost:8787`。用本机 dev 库的账号密码登录（没有就在登录页注册，或管理端 `http://localhost:8787/admin` 建号；测生成链路需要该账号有积分）。
2. `editorMode` 缺省=开，无需配置即可见入口。**专门测开关**时：管理端「用户管理」抽屉关/开「实时剪辑模式」，客户端 ≤30s 心跳生效（被关后 `/frame-editor` 应重定向到第一个可用模式）。
3. 三个入口任选：新建项目页「进入实时剪辑」按钮 / 项目内顶部标题栏「实时剪辑」页签 / 直接改地址栏 `/frame-editor`。

### 3. 桌面路径（测导出时）

项目根：

```powershell
npm run dev:desktop
```

（= `tauri dev`，首次编译 Rust 数分钟；vite 端口冲突时先停浏览器路径的 client。）导出前确认本机装了剪映：草稿根 `%LOCALAPPDATA%\JianyingPro\User Data\Projects\com.lveditor.draft` 存在；不存在时导出按钮会明确报错并附探测路径（这本身也是一个用例）。

### 4. 冒烟清单（按依赖顺序）

1. **时间轴基础**：左面板拖一张图到时间轴 → 生成 3s 片段；拖动/两端 trim/播放头分割/Delete/Ctrl+Z 全链；分割后两段拖开、各自 trim——**验证引用同一素材不同窗口**（右栏素材源信息里 assetId 相同）。
2. **磁吸/缩放**：吸附开关下拖动片段贴齐邻缘；Ctrl+滚轮以鼠标为锚缩放；工具条时间码跟随播放头。
3. **分镜占位**：项目先在资产模式跑一集智能推理 → 回实时剪辑，中央舞台「按分镜生成占位」选分集 → 逐镜占位入轨；**再点一次应全部 skipped（幂等）**。
4. **生成链路**（花积分，用小额账号）：点占位符 → 右栏推理提示词 → 生成故事板 → 生成视频 → 成片**原位替换**占位符（target 位置时长不动）；服务端管理端「请求记录」应出现对应 purpose 条目。
5. **预览**：播放按钮 → 主视频轨顺序播放、音轨同步、播放头竖线跟随；暂停拖播放头画面跟随；播完自动停。
6. **导出（仅桌面路径）**：工具条「导出剪映草稿」→ 成功提示带草稿名 → 打开剪映验证：草稿可见可打开、时间轴还原（位置/时长/裁剪窗口）、**分割片段共用同一素材**（剪映素材库该素材只有一份）、媒体不丢失（草稿 assets\ 自包含）。
7. **持久化**（桌面路径）：保存项目 → 重开 → rtcDoc 完整还原（轨道/片段/占位符）。

## 验证

- 上述 7 项全绿；控制台零业务报错。
- 静态基线随手复核：`npx vitest run` 全绿（第235轮基线 682，rtc 相关测试 80 条）。

## 踩坑红线

1. ⚠ **导出/落盘在浏览器路径必然失败**——`exportRtcDocToJianying` 首行判 isTauri，报「仅在桌面版可用」不是 bug；测导出必须 `npm run dev:desktop`。
2. ⚠ **占位符自动替换是会话级监听**——生成期间刷新页面/重启客户端，成片仍会由 generationQueue 找回写入分镜历史，但**不再自动换占位**（第235轮已知边界）；手动在右栏「设为当前」后重新关联属预期，别当回归修。
3. ⚠ **rtc 数据变更唯一路径=`rtcStore.commit`**（§9A 第235轮）——调试时想改 doc 也走 `useRtcStore.getState().commit(d => …)`，直写 setState 不进 undo 不落盘，会测出假象。
4. ⚠ **测试项目写的是真实用户数据目录**（`AppData\Roaming\com.qiji.canvas\Qiji\projects\`），测完删项目；生成真单会真扣积分、真调上游——冒烟用 echo/小额模型。
5. ⚠ 基础环境的全部红线（tsx 僵尸、PowerShell 5.1 无 `&&`、dev 真实库勿脏写）见 `qiji-dev-env-start`，此处不重复但同样生效。

## 相关文件

| 用途 | 路径 |
|---|---|
| 模式页面外壳 | `src\views\FrameEditor.tsx` |
| 实时剪辑全部组件（时间轴/资产/属性/预览/占位） | `src\rtc\` |
| 数据模型/纯操作/运行时 store | `src\types\rtc.ts`、`src\lib\rtcOps.ts`、`src\store\rtcStore.ts` |
| 导出器（纯构建 + 编排） | `src\lib\jianyingDraft.ts`、`src\services\jianyingExport.ts` |
| Rust 导出命令（jianying_draft_root / prepare / copy_assets / write_draft_file） | `src-tauri\src\lib.rs` |
| 模式守卫表 MODE_ROUTE_TABLE | `src\App.tsx` |
| 服务端开关合成 | `server\src\store\agents.ts` |
| 第235轮完整记录与锁定规则 | `qiji/CLAUDE.md` §8 第235轮、§9A 前五条 |
