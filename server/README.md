# Qiji 管理端网关（server）

用户端 → **本服务** → 第三方 API。本服务持有真 key，负责翻译/转发/规范化、分配资产 id。
与用户端共用同一份契约：`server/src/contract.ts` 直接 re-export 根目录 `../src/contract.ts`。

> 阶段2 第一刀（骨架）：5 个端点 + 一个真文本翻译器(OpenAI 兼容) + 占位异步任务 + 内存存储。
> 尚未接入 Postgres / S3 / Claude / Gemini / 简梦，留待后续加深。

## 运行

```bash
cd server
npm install
cp .env.example .env      # 填 GATEWAY_API_KEY（g-aisc 的 sk- 密钥）；不填也能用 echo / 占位 联调
npm run dev               # tsx watch，默认 http://localhost:8787
# 或 npm start（单次）/ npm run typecheck
```

上游是聚合网关 **g-aisc**（`https://sub.g-aisc.com`）：一把 `sk-` 密钥、`Authorization: Bearer`，同时兼容 OpenAI / Anthropic / Gemini 三协议。填一个 `GATEWAY_API_KEY` 即可让全部真实模型可用。

## 管理端控制台

浏览器打开 **`http://localhost:8787/admin`**，用 `ADMIN_TOKEN`（默认 `admin-dev`）登录，三个页签：

- **用户管理**：增删改查用户（用户名/额度/备注/启用），复制或重置 `accessKey`。用户端用此 accessKey 登录；禁用后该用户立即不可用（登录/心跳/请求均 401）。
- **模型加载**：增删改模型，编辑"翻译格式"——`protocol`（echo / openai-chat / anthropic-messages / openai-image / gemini-image / stub）+ 上游模型名 + 可选 `baseUrl`/`apiKey` 覆盖（留空走网关）。改动即时反映到用户端 catalog（version 自增）。
- **请求记录**：每次 `/generate` 的请求时间、完成时间、用户、步骤(`purpose`)、模型、状态、耗时；点详情看完整请求 + 完整响应/结果。

数据持久化在 `server/data/`（users.json / models.json / 请求记录按天分文件 logs-index/<日期>.jsonl + 详情 logs/<id>.json），重启不丢，`.gitignore` 已忽略。

## 登录与心跳（用户端）

- `POST /v1/login {accessKey}` → 校验启用用户。
- `POST /v1/heartbeat`（Bearer accessKey）→ 用户端每 30s 调一次；返回 401（被禁用/删除）则用户端登出回登录页。
- 用户端首启即显示登录页（服务器地址 + accessKey），**未登录不可用**。

用户端连接：设置 → 管理端 → 服务器地址 `http://localhost:8787`，accessKey `dev-key`（见 `.env` 的 `ACCESS_KEYS`）→ 测试连接并拉取目录。

## 端点（契约见 src/contract.ts）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（公开，无需 accessKey） |
| GET | `/v1/catalog?since=` | 下发目录；`since` 与当前版本一致回 `304` |
| POST | `/v1/generate` | 文本同步出结果；图/视频/音频回 `{taskId}` |
| GET | `/v1/tasks/:id` | 四态归一：queued/running/success/failed |
| POST | `/v1/batch` | 批量提交（同步结果也归一成可轮询 taskId） |
| GET | `/v1/batch/:id` | 批次状态 + summary |
| POST | `/v1/assets` | multipart 上传 → `{id,url}`（id 全局单调永不复用） |
| GET | `/v1/assets/:id` | 凭 id 重解析 url |
| GET | `/v1/assets/:id/raw` | 资产原始字节 |

鉴权：除 `/health` 外，所有 `/v1/*` 需 `Authorization: Bearer <accessKey>`。

## catalog 内置模型（均走 g-aisc 网关，除 echo/stub 外需 `GATEWAY_API_KEY`）

文本（同步返回）：
- `echo-text`（无需密钥，原样回声，联调用）
- `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` / `gpt-5.3-codex`（OpenAI `/v1/chat/completions`；`output.format=json` 启用 `json_schema` 结构化输出）
- `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5-20251001`（Anthropic `/v1/messages`，Bearer 鉴权；`output.format=json` 用 **tool-use 强制**：catalog schema 当工具 input_schema + `tool_choice` 强制 + 读 `tool_use.input`）

图像（真异步：返回 taskId → 后台调上游 → 落资产 → 轮询取回）：
- `gpt-image-2`（OpenAI `/v1/images/generations`，`response_format=b64_json` 直接取字节）
- `gemini-3-pro-image-preview` / `gemini-3.1-flash-image-preview`（Gemini `generateContent`，`responseModalities:["TEXT","IMAGE"]`，从 `inlineData` 取字节）
- `stub-image`（无需密钥占位）

视频 / 音频：`stub-video` / `stub-audio`（暂无上游，占位）。

## 冒烟（PowerShell/curl）

```bash
curl http://localhost:8787/health
curl http://localhost:8787/v1/catalog -H "Authorization: Bearer dev-key"
# Windows 下中文 body 建议用 --data-binary @file 避免 Content-Length 报错
```

## 目录结构

```
server/src/
  index.ts        # Fastify 启动（CORS/multipart/路由插件）
  config.ts       # .env 读取
  auth.ts         # Bearer accessKey 校验 hook
  catalog.ts      # 目录数据 + 输出 schema
  routes.ts       # 5 端点
  contract.ts     # re-export 根 ../../src/contract（两端共用）
  store/
    tasks.ts      # 任务内存表 + 四态时间机
    assets.ts     # 资产内存表 + 全局单调 id 序列
  translators/
    openai.ts     # 真文本翻译器（结构化输出强制）
    index.ts      # 按 model/capability 路由（echo / openai / 占位）
```

## 后续加深（阶段2 余下）

- 接 Postgres（资产 id 用 SEQUENCE）+ S3 兼容对象存储
- Gemini responseSchema / 简梦视频 翻译器（需用户提供各家 API 文档）
- 批量的依赖拓扑排期（`fromTask`/`part`）、并发上限、幂等去重、断点续传
- accessKey 签发 + 权限/积分
