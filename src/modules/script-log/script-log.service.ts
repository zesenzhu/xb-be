/**
 * @file: script-log.service.ts
 * @description: 日志模块业务逻辑层。负责历史日志的清理与归档逻辑。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ScriptLogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScriptLogService.name);
  private cleanTimer: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap() {
    // 启动时立即执行一次清理，之后每 24 小时执行一次
    this.cleanOldLogs();
    this.cleanTimer = setInterval(() => {
      this.cleanOldLogs();
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * 自动清理 7 天前的历史日志
   */
  async cleanOldLogs() {
    try {
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() - 7);

      const result = await this.prisma.scriptLog.deleteMany({
        where: {
          timestamp: {
            lt: expirationDate,
          },
        },
      });

      if (result.count > 0) {
        this.logger.log(`[定时任务] 成功清理 7 天前过期历史日志, 影响行数: ${result.count} 行`);
      }
    } catch (err) {
      this.logger.error('[定时任务] 清理过期历史日志出错:', err);
    }
  }
}
