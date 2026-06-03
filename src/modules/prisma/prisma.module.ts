/**
 * @file: prisma.module.ts
 * @description: 全局共享数据库模块。导出 PrismaService 实例。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
