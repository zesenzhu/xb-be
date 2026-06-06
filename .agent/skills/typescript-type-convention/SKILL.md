---
name: typescript-type-convention
description: TypeScript 强类型规范技能。提倡“能不用 any 就不用”的原则。对于未知数据或复杂逻辑，优先设计或复用 Interface/Type，或使用 unknown 进行类型收窄，规避 any 滥用。
---

# TypeScript 强类型规约 (typescript-type-convention)

本技能包定义了统一的 TypeScript 编码类型规范。在编写后端 NestJS 模块、服务层 (Service)、控制器 (Controller)、中间件、拦截器以及自定义装饰器时，**必须严格遵循“高类型安全性”原则，禁止滥用 `any`**。

---

## 1. 核心规约准则

### 1.1 “Any-Free” 铁律（能不用 any 就不用）
*   **原则**：`any` 会彻底关闭 TypeScript 的编译器类型安全检查。除非是非常极端、无法解决的第三方库类型冲突，否则**一律禁止**直接声明变量、函数参数或返回值为 `any`。
*   **自建类型/复用实体**：如果没有现成的类型，应当优先根据数据结构自主声明 `interface` 或 `type`。在处理数据库相关实体时，应优先复用 Prisma 自动生成的 Client 实体类型（如 `User`、`Role` 等），严禁使用 `any` 代替。

### 1.2 替代 any 的三种黄金方案
1.  **优先使用 DTO 或自建类型**：
    *   后端接口入参必须通过 DTO (Data Transfer Object) 进行规范定义，并配合 `class-validator` 装饰器进行物理校验。
    *   API 内部数据传递、联合查询结果应使用接口或扩展类型（如使用交叉类型 `User & { role: Role }`）明确表达。
2.  **使用 `unknown` 配合类型收窄 (Type Narrowing)**：
    *   对于外部未验证的请求载荷、动态读取的 JSON 字段等，声明为 `unknown` 而不是 `any`。在使用时，通过 `typeof`、`instanceof`、`in` 操作符或自定义类型守卫进行收窄。
3.  **使用泛型 (Generics) 保留上下文类型**：
    *   在编写通用的基类、CRUD 服务、公共拦截器或工具函数时，使用泛型 `<T>` 将类型控制权交给调用方，避免直接使用 `any` 破坏链式调用中的类型推导。

---

## 2. 场景化代码示例

### 2.1 场景一：后端服务数据交互与联合查询
当通过 Prisma 进行数据库操作且包含关联查询时，严禁使用 `any` 接收。

*   **错误示范 🔴（使用 any 丢失类型安全）**：
    ```typescript
    // 错误：直接把联合查询结果定义为 any，后续属性拼写错误编译器不会报错
    async getUserWithRole(id: string): Promise<any> {
      return this.prisma.user.findUnique({
        where: { id },
        include: { role: true }
      });
    }

    const user = await this.getUserWithRole("123");
    console.log(user.Role.name); // ⚠️ 拼写错误（Prisma 默认关联对象为小写 role），TS 不报错，导致运行时 undefined 报错崩溃
    ```

*   **正确示范 🟢（使用交叉类型或 Prisma 原生推导）**：
    ```typescript
    import { Prisma } from '@prisma/client';

    // 正确：使用 Prisma 的联合类型声明返回值
    type UserWithRole = Prisma.UserGetPayload<{
      include: { role: true }
    }>;

    async getUserWithRole(id: string): Promise<UserWithRole | null> {
      return this.prisma.user.findUnique({
        where: { id },
        include: { role: true }
      });
    }

    const user = await this.getUserWithRole("123");
    if (user) {
      console.log(user.role.name); // ✅ 安全访问，若拼写错误（如 Role）TS 编译器会立刻报错
    }
    ```

---

### 2.2 场景二：NestJS 拦截器中处理未知请求体
在处理全局拦截器、中间件中捕获到的数据载荷。

*   **错误示范 🔴（滥用 any）**：
    ```typescript
    // 错误：使用 any 绕过检查，在运行时可能导致属性访问崩溃
    function extractLogMeta(body: any) {
      console.log(body.metadata.userId); // ⚠️ 如果 body 为空或没有 metadata 属性，直接运行时报错崩溃
    }
    ```

*   **正确示范 🟢（使用 unknown + 类型收窄）**：
    ```typescript
    // 正确：声明为 unknown，安全地进行存在性校验和属性判断后才允许访问
    function extractLogMeta(body: unknown) {
      if (
        body && 
        typeof body === 'object' && 
        'metadata' in body &&
        body.metadata &&
        typeof body.metadata === 'object' &&
        'userId' in body.metadata
      ) {
        console.log((body.metadata as { userId: string }).userId); // ✅ 安全取值
      } else {
        console.log("无效的数据结构");
      }
    }
    ```

---

### 2.3 场景三：封装通用 CRUD 基类服务
当编写通用泛型类或工具，处理多种实体数据时。

*   **错误示范 🔴（使用 any 导致失去类型推导）**：
    ```typescript
    // 错误：使用 any 导致继承此类的具体服务全部丢失实体类型信息
    class BaseCrudService {
      constructor(protected readonly model: any) {}
      async findOne(id: string): Promise<any> {
        return this.model.findUnique({ where: { id } });
      }
    }
    ```

*   **正确示范 🟢（使用泛型 Generics）**：
    ```typescript
    // 正确：使用泛型 TDelegate 和 TEntity，完美保留具体实体的类型上下文
    interface PrismaModelDelegate<TEntity> {
      findUnique(args: { where: { id: string } }): Promise<TEntity | null>;
    }

    class BaseCrudService<TEntity> {
      constructor(protected readonly model: PrismaModelDelegate<TEntity>) {}
      
      async findOne(id: string): Promise<TEntity | null> {
        return this.model.findUnique({ where: { id } });
      }
    }
    ```

---

## 3. 极少数必须使用 any 的豁免条件

在极少数情况下（如处理包含多重元编程推导的 NestJS 底层 Reflect-Metadata 或者是动态扩展第三方装饰器），如果实在无法消除编译错误而必须使用 `any`，必须满足以下条件：
1.  **添加 `// eslint-disable-next-line @typescript-eslint/no-explicit-any`**：并在上方加一行中文注释，简要说明**为什么这里不能用更安全的 interface 或 unknown**。
2.  **避免 any 的污染扩散**：应尽快将该 `any` 变量通过断言 `as PreciseType` 或类型收窄转化为明确的安全类型，严禁让 `any` 作为服务层的公共 API 返回值扩散给外部调用者。

---

## 4. 辅助自检清单

在提交包含 TypeScript 代码的修改前，请确保：
1. [ ] 代码中是否新增了 `any` 声明？如果有，能否通过 `interface`、`type` 或 `unknown` 代替？
2. [ ] 新增的 API DTO、服务层方法入参及返回值是否都建立了清晰的类型说明？
3. [ ] 必须使用泛型以保留实体上下文的地方是否正确使用了 `<T>`？
4. [ ] 仅在极端不可避免的情况下使用 `any`，且是否添加了中文原因释义？
