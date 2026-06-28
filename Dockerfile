# ==========================================
# 1. 编译阶段 (Builder Stage)
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# 全局安装 pnpm
RUN npm install -g pnpm

# 复制依赖描述文件与 Prisma 模式定义
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

# 允许所有的依赖在非交互式环境中运行构建脚本以避免 ERR_PNPM_IGNORED_BUILDS，并使用平铺模式 (hoisted) 安装防止多阶段构建 COPY 软链断裂
RUN echo "dangerouslyAllowAllBuilds: true" > pnpm-workspace.yaml && echo "node-linker: hoisted" >> pnpm-workspace.yaml

# 安装完整开发依赖与生产依赖
RUN pnpm install --frozen-lockfile

# 物理生成 Prisma TS 类型声明
RUN npx prisma generate

# 复制所有源代码物理编译
COPY . .
RUN pnpm run build
RUN pnpm prune --prod

# ==========================================
# 2. 运行阶段 (Runner Stage)
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

# 设置生产环境变量
ENV NODE_ENV=production

# 物理拷贝编译产物与全部依赖目录
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.mjs ./prisma.config.mjs

# 物理暴露后端 NestJS 的 8081 端口
EXPOSE 8081

# 容器拉起引导：先通过 Prisma db push 物理同步表结构，再用 Node.js 运行主入口文件
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/src/main.js"]
