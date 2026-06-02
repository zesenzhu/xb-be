# XBNEST 智能后端开发助理指南 (AGENTS.md)

> [!NOTE]
> 本文档是专为 AI 编程助手（如 Antigravity、Cursor、Claude-Dev）及后端开发者编写的**系统级后端开发规约与避坑指南**。
> 本仓库已在 `.agent/` 专属目录下内置了核心开发技能体系（Skills）。当您在此仓库进行任何代码编写、模块重构、TS 类型修改或 Prisma 结构定义时，**必须首先阅读并加载系统技能包**。

---

## 🛠 本仓库内置 AI 技能包说明 (AI Skills)

我们为后端开发创建了专用的技能扩展包，其中封装了严格的 TS 规范、注释规约、架构约束以及高保真实践代码：

### 1. 📝 代码注释与说明规范技能包 (commenting-convention)
*   **技能定义文件**：[backend/.agent/skills/commenting-convention/SKILL.md](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/commenting-convention/SKILL.md)
*   **开发金科铁律**：**每次开发、新增或重构代码都必须附带清晰、自解释的全中文说明**。杜绝直译代码的废话注释，深度阐述“Why, not What”。
*   **附属资产**：[UserEntityWithJSDoc.ts (JSDoc 规范实体样板)](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/commenting-convention/examples/UserEntityWithJSDoc.ts)

### 2. ⚡️ 高性能后端架构开发技能包 (backend-dev-guide)
*   **技能定义文件**：[backend/.agent/skills/backend-dev-guide/SKILL.md](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/SKILL.md)
*   **开发金科铁律**：Prisma 实体的级联删除、高频 MQTT 分发的多级 Redis 缓存、Socket.IO 房间安全物理隔离推送、以及基于 Redis 的授权码 QPS 滑动窗口限制。
*   **附属资产**：
    *   **一键 Prisma 迁移与类型同步脚本**：[prisma-sync.sh](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/scripts/prisma-sync.sh)
    *   **Socket.IO 隔离房间广播范例**：[LogSocketGateway.ts](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/examples/LogSocketGateway.ts)
    *   **Redis 高并发 QPS 令牌拦截器范例**：[QpsRateLimiter.ts](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/examples/QpsRateLimiter.ts)

---

## 1. 项目概览与极速启动

本项目为智能后台与对外 SaaS 用户端大屏一体化系统的**核心后端服务**。

*   **物理路径**：`file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend`
*   **技术栈**：NestJS 11.x + TypeScript + Prisma ORM + PostgreSQL + Redis + Socket.IO + MQTT。
*   **启动命令**：`npm run start:dev` 或 `pnpm dev`

---

## 2. TypeScript 类型约束与接口契约

项目采用**全量 TypeScript 严格类型约束**，严禁滥用 `any`。

### 2.1 DTO 与 Prisma 模型契约对齐
*   所有的接口数据请求（Request Body、Query Params）和响应（Response Body）都必须有对应的类型声明（如 `dto/*.dto.ts`）与 TS 类型声明。
*   对外输出的数据结构应与 Prisma 自动生成的 Model 保持强一致或定义精准的映射，严禁隐式改变类型或输出未定义字段。

### 2.2 响应格式统一与拦截器
*   所有 HTTP 响应必须经过全局响应拦截器 `TransformInterceptor` 进行包装，格式为：
    ```ts
    interface ApiResponse<T> {
      success: boolean;
      code: number;
      message: string;
      data: T;
    }
    ```
*   严禁在 Controller 层手动硬编码此结构，必须直接返回原始数据或 DTO，由拦截器自动打包。

---

## 3. 数据库与 Prisma Schema 开发规范

### 3.1 关系设计规范
*   表关系必须有明确的级联删除（`onDelete: Cascade`）或关联处理逻辑。
*   在高频检索的字段（如 `deviceId`、`level`）上必须建立联合索引或单列索引，以提升高并发检索性能。

### 3.2 迁移命令规范
在对 `schema.prisma` 做出修改后，必须运行 [prisma-sync.sh](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/backend-dev-guide/scripts/prisma-sync.sh) 进行一键迁移与 TS 实体同步，严禁手工物理改表。

---

## 4. AI 助手承诺与输出原则
1.  **使用中文输出**：所有代码注释、Swagger 接口描述、Git 提交信息以及技术方案建议必须**全中文**，表达清晰、语调专业、保持谦逊。
2.  **严格遵循异常过滤**：编写业务逻辑时抛出 NestJS 标准异常（如 `NotFoundException`、`BadRequestException`），绝不能裸抛 `Error` 导致进程崩溃，确保异常被全局过滤器安全捕获并格式化输出。
3.  **不使用 placeholder 占位符**：编写的代码应是可以直接运行的完整逻辑，不能留有 “待实现” 等无效空注释。
