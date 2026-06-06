/**
 * @file: script-log.module.ts
 * @description: 运行日志模块定义。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import { Module } from '@nestjs/common';
import { ScriptLogController } from './script-log.controller';
import { ScriptLogService } from './script-log.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TcpSocketModule } from '../tcp-socket/tcp-socket.module';

@Module({
  imports: [PrismaModule, TcpSocketModule],
  controllers: [ScriptLogController],
  providers: [ScriptLogService],
  exports: [ScriptLogService],
})
export class ScriptLogModule {}
