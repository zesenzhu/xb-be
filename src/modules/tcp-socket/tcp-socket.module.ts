/**
 * @file: tcp-socket.module.ts
 * @description: TCP Socket 运行模块。负责注入底层数据库并与注册码模块循环依赖挂载。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import { Module, forwardRef } from '@nestjs/common';
import { TcpSocketService } from './tcp-socket.service';
import { RegisterCodeModule } from '../register-code/register-code.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => RegisterCodeModule),
  ],
  providers: [TcpSocketService],
  exports: [TcpSocketService],
})
export class TcpSocketModule {}
