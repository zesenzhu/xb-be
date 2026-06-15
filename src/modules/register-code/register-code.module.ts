/**
 * @file: register-code.module.ts
 * @description: 注册码管理模块。声明控制器与服务，配置 Prisma 与 TCP Socket 模块的依赖关系。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import { Module, forwardRef } from '@nestjs/common';
import { RegisterCodeService } from './register-code.service';
import { RegisterCodeController } from './register-code.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { TcpSocketModule } from '../tcp-socket/tcp-socket.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    PrismaModule,
    forwardRef(() => TcpSocketModule),
    NotificationModule,
  ],
  controllers: [RegisterCodeController],
  providers: [RegisterCodeService],
  exports: [RegisterCodeService],
})
export class RegisterCodeModule {}
