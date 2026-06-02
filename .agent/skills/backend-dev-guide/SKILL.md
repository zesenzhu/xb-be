---
name: backend-dev-guide
description: NestJS 11.x 模块化开发, Prisma ORM 实体关系映射, MQTT 与 Socket.IO 高并发实时推送技能指南。
---

# NestJS 后端架构与高性能数据推送开发技能规约 (backend-dev-guide)

本技能包专为 NestJS 后端仓库设计。当您在该仓库进行任何控制器编写、数据模型更改、长连接开发或中间件限流拦截配置时，**必须完全遵循本规约**以保障系统健壮性。

---

## 1. 核心技能：TypeScript 接口类型与 DTO 严格对齐

后端在提供 HTTP 服务时，所有输入和输出必须具有强类型的实体契约。

### 1.1 DTO 输入检验与数据转型 (ValidationPipe)
*   **输入检验**：必须在 Controller 层接口入参上显式绑定 DTO（如 `CreateUserDto`），且必须利用 `class-validator`（如 `@IsString()`, `@IsEmail()`, `@IsUUID()`）对每个输入字段进行精确强约束。
*   **物理隐式转型**：全局 `ValidationPipe` 必须开启 `transform: true`，确保传入的路由 Query 参数（如 `page=1`）能够被物理自动转型为 `number`，杜绝手动 `parseInt`。

### 1.2 Prisma 实体定义与 Schema 级联机制
*   在 `schema.prisma` 中对任何关系进行定义时，严禁使用裸外键。必须显式定义 `@relation` 的 `fields` 及 `references`。
*   支持**级联删除 (Cascade)**：如果父项被删除，其关联的子数据必须自动级联清除，规避数据库孤立数据碎片的产生。
*   在高并发检索的物理字段上配置联合索引（如 `@@index([deviceId, level])`）以保证高性能日志多维正则查找（Regex Fuzzy Search）能走索引扫描。

---

## 2. 核心技能：高并发通信（MQTT + WebSockets）桥接

后端作为 EMQX（MQTT）与前端 WebSockets（Socket.IO）的桥接总线，必须确保数据分发吞吐与物理隐私安全隔离。

### 2.1 高频 MQTT 接收削峰与缓存映射
*   设备脚本日志通过 `device/+/log` 主题以毫秒级高频投递到 EMQX。
*   **吞吐限流缓存**：NestJS 在订阅接收到帧后，**严禁**为每个日志帧进行 SQL 全表查询去匹配所有者。
*   **方案**：必须设计 `DeviceId -> UserId` 的 Redis Hash 映射。
    *   首先从 Redis 极速度读取，命中则直接转发；
    *   未命中则从 PostgreSQL 查询，同时写入 Redis，失效期设为 10 分钟。保证内存高速过滤。

### 2.2 WebSockets 精准房间隔离推送 (Rooms Isolation)
*   Socket.IO 网关接收到前端连接后，在 `handleConnection` 时必须解析前端 JWT Cookie（提取 `userId`）。
*   **物理房间安全**：客户端 socket 连接成功后，直接将其拉入其用户专属的隔离房间 `socket.join("room_user_" + userId)`。
*   推送时仅定向发给该房间（`server.to("room_user_" + userId).emit(...)`）。严禁广播以避免多用户多设备日志泄露的安全隐患（参见 [LogSocketGateway.ts](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/examples/LogSocketGateway.ts) 示例）。

---

## 3. 核心技能：基于 Redis 令牌桶的注册码 QPS 拦截限流

为了防止下位机端侧或恶意用户使用注册码刷屏导致服务器 QPS 爆栈：
*   必须利用 Redis 建立分布式速率限制器 (Rate Limiter)。
*   在 `LicenseCode` 表中定义该激活码的 `rateLimit`（如 5 Req/Sec）。
*   在拦截器中（参见 [QpsRateLimiter.ts](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/examples/QpsRateLimiter.ts)），对于请求该激活码接口的客户端物理 IP / 激活码进行秒级计数拦截。

---

## 4. 辅助开发脚本与示例

*   **Prisma 迁移与同步脚本**：运行 [prisma-sync.sh](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/scripts/prisma-sync.sh) 一键完成 schema 修改到 DB 物理同步并更新 client 类型。
*   **高性能长连接桥接网关样板**：查看 [LogSocketGateway.ts](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/examples/LogSocketGateway.ts)。
*   **Redis 分布式 QPS 速率拦截器样板**：查看 [QpsRateLimiter.ts](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/examples/QpsRateLimiter.ts)。
