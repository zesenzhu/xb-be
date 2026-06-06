/**
 * @file: main.ts
 * @description: NestJS 物理进程引导入口文件。配置了路由全局前缀、CORS 跨域携证及 Swagger API 在线交互文档。
 * @author: Antigravity AI
 * @date: 2026-06-02
 *
 * [核心职责]
 * 1. 引导启动：初始化 NestFactory 应用实例；
 * 2. 物理跨域：配置 CORS credentials 允许前端 Next.js 在 8080 端口跨域读写 HttpOnly Cookie；
 * 3. 统一前缀：前置 /api 路由，以对齐前端 baseURL 请求契约；
 * 4. 自动文档：初始化 Swagger (OpenAPI 3.0)，将其托管映射在 /api/docs 页面。
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PrismaClient } from '@prisma/client';
import { seedDatabase } from '../prisma/seed';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { apiReference } from '@scalar/nestjs-api-reference';

async function bootstrap() {
  // 1. 初始化 NestJS 服务实例
  const app = await NestFactory.create(AppModule);

  // 2. 开启统一物理路由前缀 /api，与前端 lib/axios.ts 设定的 http://localhost:8081/api 保持一致
  app.setGlobalPrefix('api');

  // 3. 开启跨域 CORS 配置
  // ⚠️ 避坑铁律：因为本系统鉴权采用物理 Cookie (HttpOnly 登录双通道) 方案，
  // 跨域通信时必须允许 credentials 携带。当 credentials 设为 true 时，
  // origin 绝不能设置为通配符 "*"，此处设为 true 会自动动态反射请求头的 origin。
  app.enableCors({
    origin: true, 
    credentials: true, 
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Accept,Authorization,X-Requested-With,X-License-Code',
  });

  // 4. 集成 NestJS 官方 Swagger (OpenAPI 3.0) 自动文档生成器
  // 基于 DTO 与装饰器实现“代码即文档”秒级同步，托管于 /api/docs 路径下
  const config = new DocumentBuilder()
    .setTitle('XBNEST 全栈智能后台 API 接口文档')
    .setDescription(
      'XBNEST 全栈管理系统后端 HTTP API 接口说明书。' +
      '涵盖用户鉴权、RBAC 角色权限、注册码授权速率限制、高频脚本终端日志分发及 AI Agent 推理调度核心板块。' +
      '前端地址: http://localhost:8080 | 后端地址: http://localhost:8081 | 文档地址: /api/docs'
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: '方便 Bearer JWT 调试令牌',
      },
      'bearer'
    )
    .build();

  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true, // 刷新页面后依然保持 Bearer 鉴权状态
      },
    });

    // ⚡ 集成并挂载 Scalar 现代交互文档参考页面
    app.use(
      '/api/reference',
      apiReference({
        theme: 'purple',
        spec: {
          content: document,
        },
      }),
    );
  }

  // 5. 自动静默播种初始数据 (完美穿透 WASM 虚拟本地库的物理连接屏障)
  const prismaOptions: any = {};
  const dbUrl = process.env.DATABASE_URL || '';
  let pool: Pool | undefined;
  if (dbUrl.startsWith('prisma://') || dbUrl.startsWith('prisma+postgres://')) {
    prismaOptions.accelerateUrl = dbUrl;
  } else if (dbUrl) {
    pool = new Pool({ connectionString: dbUrl });
    prismaOptions.adapter = new PrismaPg(pool);
  }
  const prisma = new PrismaClient(prismaOptions);
  try {
    const userCount = await prisma.user.count();
    if (userCount === 0) {
      console.log('[NestJS] ⚙️ 检测到 sys_user 数据库表为空，正在主进程物理上下文中自动进行数据播种...');
      await seedDatabase(prisma);
    }
  } catch (seedErr) {
    console.warn('[NestJS] ⚠️ 自动执行初始数据播种提示 (如迁移阶段表尚不存在):', seedErr.message);
  } finally {
    await prisma.$disconnect();
    if (pool) {
      await pool.end();
    }
  }

  // 6. 监听端口，环境变量优先，兜底为规范后的 8081
  const port = process.env.PORT || 8081;
  await app.listen(port);
  console.log(`[NestJS] 🚀 智能后端服务成功拉起！`);
  console.log(`[NestJS] 🔗 联调服务地址: http://localhost:${port}/api`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[NestJS] 📖 交互 Swagger 文档已托管在: http://localhost:${port}/api/docs`);
    console.log(`[NestJS] 🚀 Scalar 接口文档已托管在: http://localhost:${port}/api/reference`);
  }
}
bootstrap();
