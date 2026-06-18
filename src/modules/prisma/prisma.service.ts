/**
 * @file: prisma.service.ts
 * @description: 全局 Prisma 数据库服务。继承自 PrismaClient，提供生命周期托管以自动管理连接池。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private pool?: Pool;

  constructor() {
    const options: any = {
      log: ['error', 'warn'],
    };
    const dbUrl = process.env.DATABASE_URL || '';
    let poolInstance: Pool | undefined;

    if (
      dbUrl.startsWith('prisma://') ||
      dbUrl.startsWith('prisma+postgres://')
    ) {
      options.accelerateUrl = dbUrl;
    } else if (dbUrl) {
      poolInstance = new Pool({ connectionString: dbUrl });
      const adapter = new PrismaPg(poolInstance);
      options.adapter = adapter;
    }
    super(options);
    this.pool = poolInstance;
  }

  /**
   * 模块初始化生命周期：物理开启数据库长连接
   */
  async onModuleInit() {
    await this.$connect();
    console.log(
      '[PrismaService] 🔌 PostgreSQL (pglite) 数据库连接已成功物理激活。',
    );
  }

  /**
   * 模块销毁生命周期：物理释放数据库长连接池，防止连接泄露
   */
  async onModuleDestroy() {
    await this.$disconnect();
    if (this.pool) {
      await this.pool.end();
    }
    console.log(
      '[PrismaService] 🔌 PostgreSQL (pglite) 数据库连接池已安全释放销毁。',
    );
  }
}
