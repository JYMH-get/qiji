# Qiji 复刻 · 漫剧创作无限画布

企业级无限画布 + 节点图应用，面向 AI 漫剧创作。统一指令核心（同源 GUI / Copilot / Agent），
单向 DAG 数据血缘，脚本爆破成分镜，统一 Model Hub 适配层，错峰自动模式（人机协作）。

> 本仓库为 **Phase 0 脚手架**：地基与抽象层就位，节点为占位实现。完整路线见架构蓝图（Notion）。

## 运行

```bash
npm install
npm run dev
```

打开终端提示的本地地址即可看到画布、左侧边栏与四类节点。

## 技术栈

- **Vite + React 18 + TypeScript**
- **@xyflow/react (React Flow 12)** — 无限画布 / 节点图 / 连线 / MiniMap
- **Zustand** — 扁平 Map + 细粒度 action（CRDT 友好，预留 Yjs 协同）

## 目录结构 → 架构映射

| 路径 | 职责 | 蓝图对应 |
| --- | --- | --- |
| `src/types/index.ts` | 全局类型（Node/Edge/Group/Asset/Project/Runtime） | 数据模型 |
| `src/command/` | 统一指令核心：Command Bus + 指令定义（同源 GUI/Copilot/Agent） | 同源双入口之魂 |
| `src/store/canvasStore.ts` | 画布状态：节点/边/分组/运行态，细粒度 action | 画布地基 |
| `src/store/libraryStore.ts` | 素材库 + 资产软删除（id 不复用） | 资产管理 |
| `src/store/projectStore.ts` | 项目（一项目 = 一画布） | 项目管理 |
| `src/store/uiStore.ts` | 选择 / 侧边栏等 UI 态 | 外壳 |
| `src/store/history.ts` | 仅结构撤销/重做栈 | 撤销策略 |
| `src/dag/validate.ts` | 单向 DAG 防环（DFS） + isValidConnection | DAG 约束 |
| `src/services/modelAdapter.ts` | 统一 Model Hub 适配契约（submit/poll/estimateCost/paramsSchema） | Model Hub |
| `src/services/taskTracker.ts` | 集中式批量轮询（预留 SSE/WS） | 执行与状态 |
| `src/services/assetStore.ts` | 资产 ID 单调递增、永不复用（本地→S3） | 资产管理 |
| `src/services/creditLedger.ts` | 积分预扣 / 结算 / 退回（错峰不打折） | 计费 |
| `src/services/scheduler.ts` | 错峰排期：continuation 串行、独立并行（拓扑分层） | 错峰自动模式 |
| `src/nodes/` | 四类节点（脚本/图片/视频/音频）+ 注册表 | 画布地基 |
| `src/canvas/` | 画布与左侧边栏 | 外壳 |

## 路线图

- **Phase 0** 脚手架（本仓库）
- **Phase 1** 画布地基（四类节点落地）
- **Phase 2** 交互富化（拖线弹菜单 / 中段插入 / 框选打组 / 仅结构撤销）
- **Phase 3** 执行与模型（Model Hub 接入 + Scheduler）
- **Phase 4** 持久化（整存 + 历史，本地资产→S3）
- **Phase 5** 脚本爆破（+ 重新爆破弹窗：增量/重建）
- **Phase 6** 外壳（Copilot 左侧边栏 / 铺改重排）
- **Phase 7** Agent OpenAPI（accessKey 独立鉴权 + 错峰自动模式）
