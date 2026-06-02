# NestJS 核心后端模块与接口设计说明

后端系统基于 **NestJS 11.x (Node.js 22+) + TypeScript** 构建，核心采用模块化、高内聚低耦合的逻辑分层。

---

## 1. 后端规范项目目录结构

```text
/Users/xiaobao/Desktop/code/个人/xbnestjs/backend
├── prisma/
│   ├── schema.prisma        # Prisma ORM 数据库核心映射 Schema
│   └── migrations/          # 数据库迁移 SQL 版本控制历史
├── src/
│   ├── common/              # 全局通用拦截器与过滤器
│   │   ├── interceptors/    # 统一 HTTP 响应、日志、QPS 限流拦截器
│   │   ├── filters/         # 全局异常捕捉与安全格式化过滤器
│   │   └── guards/          # 全局 JWT、RBAC 角色权限控制守卫
│   ├── modules/             # 系统核心业务功能模块
│   │   ├── auth/            # 鉴权管理模块 (登录、双 Token 签发、激活校验)
│   │   ├── user/            # 用户账户管理模块 (用户 CRUD, 角色关联)
│   │   ├── role/            # 角色与权限管理 (权限码控制, RBAC 数据表)
│   │   ├── code/            # 注册激活码模块 (Redis QPS 参数设置, 绑定激活)
│   │   ├── log/             # 诊断日志检索 (PostgreSQL 日志写入与正则搜索)
│   │   ├── device/          # 设备在线心跳管理 (心跳状态自检)
│   │   └── ai/              # AI Agent 推理模块 (多模型调用, Agent 执行 Timeline 联动)
│   ├── app.module.ts        # 全局配置依赖引入根模块
│   └── main.ts              # 物理进程启动引导入口 (CORS、接口前缀、Swagger配置)
├── test/                    # 单元测试与端到端测试
└── nest-cli.json            # Nest 命令行配置
```

---

## 2. 数据库设计 (Prisma Schema 关系映射)

我们规划了四张最核心的业务表设计，包含级联删除和完整的关系绑定：

*   **User (用户表)**：记录用户登录信息，绑定唯一的 Role。
*   **Role (角色表)**：包含角色代码及拥有的细粒度权限码数组（`permissions: String[]`，如 `['code:create', 'user:delete']`）。
*   **LicenseCode (注册激活码表)**：批量生成，支持限流数值 QPS 控制，记录当前已激活的端侧 MAC/IP 绑定状态。
*   **ScriptLog (运行日志表)**：高频记录端侧设备推送的警告与错误日志，字段带有联合索引以进行高并发性能检索优化。

```prisma
model User {
  id        String   @id @default(uuid())
  username  String   @unique
  password  String
  nickname  String?
  email     String?
  roleId    String
  role      Role     @relation(fields: [roleId], references: [id])
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Role {
  id          String   @id @default(uuid())
  name        String   @unique
  code        String   @unique // 'admin', 'operator', 'client'
  permissions String[] // 权限码列表，如 ["user:create", "code:delete"]
  users       User[]
}

model LicenseCode {
  id                 String   @id @default(uuid())
  code               String   @unique // 注册激活码密文
  maxActivations     Int      @default(1)
  currentActivations Int      @default(0)
  rateLimit          Int      @default(5) // 该激活码每秒最大允许 QPS 限制
  deviceId           String?  @unique // 绑定端侧的唯一 MAC/IP 标识
  status             String   @default("active") // 'active', 'disabled'
  expiresAt          DateTime
  createdAt          DateTime @default(now())
}

model ScriptLog {
  id        String   @id @default(uuid())
  deviceId  String
  level     String   // 'INFO', 'WARN', 'ERROR'
  module    String   // 来源组件
  content   String   @db.Text
  createdAt DateTime @default(now())

  @@index([deviceId])
  @@index([level])
}
```

---

## 3. 后端核心长连接与物理转发模块

### 3.1 MQTT 与 Socket.IO 转发设计
后端集成 `@nestjs/microservices` 和 `@nestjs/websockets`：
1.  **MQTT 物理信道**：NestJS 订阅 `device/+/log` 主题。端侧下位机或机器人向该 Topic 发布 JSON 格式的日志帧。
2.  **Socket.IO 实时网关**：NestJS 收到日志帧，解析其关联的 `deviceId`。比对数据库中该设备绑定的激活码所有者（User ID）。
3.  **用户长链接推送**：将该日志帧，定向向属于该 User 的前端 Socket.IO 客户端连接（使用 `socket.emit('log_stream', data)`）进行安全隔离推送。

### 3.2 401 JWT 双 Token 自动签发逻辑
*   `/auth/login`：验证密码通过，在响应头中同时 Set-Cookie 写入 `access_token`（有效期 1 小时）和 `refresh_token`（有效期 7 天）。
*   `/auth/refresh`：当客户端因为 `access_token` 过期发起该请求时，后端读取 HttpOnly Cookie 中的 `refresh_token`，若未过期，则重新 Set-Cookie 写入最新的 `access_token` 从而达到静默无感续期的目的。
