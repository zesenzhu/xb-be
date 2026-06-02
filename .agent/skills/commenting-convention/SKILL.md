---
name: commenting-convention
description: 后端 NestJS/TypeScript 统一注释与自解释代码开发技能规范。要求在每次开发中清晰说明每一处核心逻辑。
---

# NestJS 后端代码注释与说明规约 (commenting-convention)

本技能包专为 NestJS 后端系统定制。当您在后端编写控制器、服务、DTO、拦截器或 Prisma Schema 时，**必须严格按照本规约进行全中文高保真注释说明**。

---

## 1. 核心注释原则

### 1.1 "Why, not What" 铁律
*   **严禁**编写无意义的直译代码逻辑的废话注释。例如：
    ```ts
    // 错误示范：直译代码，毫无价值
    // 将 userId 赋值给 user 对象
    user.id = userId;
    ```
*   **要求**：注释必须解释“为什么这样设计”、“背后的业务痛点是什么”以及“有什么隐藏的技术陷阱”。
    ```ts
    // 正确示范：说明业务背景与技术设计目的
    // 物理防冲突隔离：此处必须使用统一格式的 'room_user_' 前缀将 socket 拉入专属房间。
    // 这能确保接下来的高并发日志流仅发送给激活了该授权码的合法所有者，防止多用户间的数据泄露。
    await socket.join(`room_user_${userId}`);
    ```

### 1.2 全量中文注释要求
根据系统级 `RULE[user_global]` 规定，所有注释、JSDoc 声明以及代码文件中的说明文字**必须全部使用中文进行编写**，表达语调应专业、严谨。

---

## 2. 物理文件与模块头部注释标准

每一个新增或重构的 TypeScript 文件，**物理头部必须包含以下格式的 JSDoc 注释**：

```ts
/**
 * @file: LogSocketGateway.ts
 * @description: 高性能 Socket.IO 实时脚本日志推送网关。
 * @author: [Your Name / AI Assistant]
 * @date: 2026-06-02
 *
 * [核心职责]
 * 1. 握手拦截：从 HTTP Header 的 Cookie 中解析并校检 JWT 身份；
 * 2. 物理房间绑定：为每个鉴权成功的用户建立独立的 Socket.IO Room 进行数据隔离；
 * 3. 极速信道转发：承接来自 MQTT 模块的高频自检日志帧，削峰后定向广播至专属房间。
 *
 * [关联依赖]
 * - WsJwtAuthGuard: 用于反向控制指令时的 WebSocket 鉴权守卫。
 * - RedisService: 用于加速 DeviceID 到 UserID 的映射缓存查询。
 */
```

---

## 3. DTO、Entity 与 Swagger 属性注释标准

在编写接口入参 DTO 或数据库 Entity 时，每个属性**必须附带详细的 JSDoc 说明及 Swagger `@ApiProperty` 描述**，明确说明字段取值范围、单位和合法格式：

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Max, Min } from 'class-validator';

export class UpdateLicenseQpsDto {
  /**
   * 需要调整 QPS 限流速率的授权激活码密文。
   * 必须是合法的 UUIDv4 格式。
   */
  @ApiProperty({
    description: '授权激活码密文',
    example: 'd3b07384-d113-49c3-a55e-04984d4090c7',
  })
  @IsString()
  code: string;

  /**
   * 该激活码每秒最大允许的物理请求速率 (QPS)。
   * 取值区间: [1, 100]，默认限制为 5 QPS，过高会触发 Redis 限流警报。
   */
  @ApiProperty({
    description: '每秒允许的物理限制速率',
    minimum: 1,
    maximum: 100,
    default: 5,
  })
  @IsInt()
  @Min(1)
  @Max(100)
  rateLimit: number;
}
```

---

## 4. 长连接与事件驱动模块注释标准

事件驱动（如 MQTT 订阅、Socket.IO 自定义事件、Bull 队列）的代码具有隐式流转的特点，**必须**在事件处理函数上方详细注释：
1.  **事件源名称** (Event / Topic Name)。
2.  **数据载荷结构** (Payload Contract)。
3.  **流转逻辑说明**（从哪里发来，处理后发给谁）。

```ts
// =========================================================================
// [事件监听] device/+/log
// [数据载荷] { deviceId: string, level: 'INFO'|'WARN'|'ERROR', content: string }
// [业务流转] 
//   1. 端侧机器人通过 MQTT 物理信道向 EMQX 发布秒级高频自检日志帧；
//   2. 后端拦截此 Topic，提取 deviceId 并从 Redis 获取其归属所有者 (UserId)；
//   3. 最终调用 LogSocketGateway 将日志隔离分发至前端 Websocket 房间。
// =========================================================================
@SubscribeMessage('log_stream')
handleDeviceLogFrame(payload: any) {
  // 核心逻辑...
}
```

---

## 5. 辅助自检与示例

*   **代码规范范例**：查看 [UserEntityWithJSDoc.ts](file:///Users/xiaobao/Desktop/code/个人/xbnestjs/backend/.agent/skills/commenting-convention/examples/UserEntityWithJSDoc.ts) 获取 JSDoc 全量中文自解释的完美代码参考。
