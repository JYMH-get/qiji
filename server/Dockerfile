# syntax=docker/dockerfile:1
# Qiji 管理端网关（BFF）运行镜像
# 说明：
#  - 服务端用 tsx 在运行时直接跑 .ts，不做编译；故不能用 --omit=dev（tsx 是 devDependency）。
#  - server/src/contract.ts 运行时 re-export 仓库根的 src/contract.ts，
#    所以镜像里必须同时有 /app/server 与 /app/src/contract.ts。
#  - 因此【构建上下文必须是仓库根目录】，构建命令示例：
#      docker build -f server/Dockerfile -t qiji-server .
# 第169轮：22→24——undici@8 要求 Node ≥22.19，且「setGlobalDispatcher 接管内置 fetch 超时」在 Node 24 实测验证；与开发机(24.16)对齐
FROM node:24-slim

WORKDIR /app/server

# 1) 依赖层（带 lockfile 做确定性安装；npm ci 默认含 devDependencies 里的 tsx）
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2) 共享契约：必须落到 /app/src/contract.ts（被 server/src/contract.ts 以 ../../src 引用）
COPY src/contract.ts /app/src/contract.ts

# 3) 服务端源码（含 server/skills/ 提示词原稿，store/templates.ts 启动 seed 时 readSkill 读它取完整正文；
#    node_modules / .env / data 已被根目录 .dockerignore 排除）
COPY server/ ./

EXPOSE 8787
CMD ["npm", "start"]
