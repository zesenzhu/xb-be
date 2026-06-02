#!/bin/bash

# 确保脚本遇到错误立即退出
set -e

# 默认迁移名
MIGRATION_NAME=${1:-"update_schema"}

echo "=== [1/2] 正在生成 Prisma 数据库迁移 SQL 并进行物理同步 ==="
npx prisma migrate dev --name "$MIGRATION_NAME"

echo "=== [2/2] 正在重新生成最新的 Prisma Client 本地 TypeScript 类型强声明 ==="
npx prisma generate

echo "✓ 恭喜！Prisma 数据库迁移与 TypeScript 类型契约极速同步完毕！"
