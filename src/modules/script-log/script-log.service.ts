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
    // 启动时立即执行一次清理，之后每 10 分钟执行一次
    this.cleanOldLogs();
    this.cleanTimer = setInterval(() => {
      this.cleanOldLogs();
    }, 10 * 60 * 1000);
  }

  /**
   * 自动分级清理历史日志：
   * 1. 裁剪所有设备的普通 INFO 日志，仅保留最新的 100 条。
   * 2. 删除 24 小时前的 WARN / ERROR 日志。
   */
  async cleanOldLogs() {
    try {
      // 1. INFO 日志单设备 100 条最新裁剪
      const infoCleanup = await this.prisma.$executeRaw`
        DELETE FROM "script_log" 
        WHERE "level" = 'INFO' 
          AND "id" NOT IN (
            SELECT "id" 
            FROM (
              SELECT "id", ROW_NUMBER() OVER (PARTITION BY "device_id" ORDER BY "timestamp" DESC) as row_num
              FROM "script_log"
              WHERE "level" = 'INFO'
            ) t
            WHERE t.row_num <= 100
          )
      `;

      // 2. ERROR/WARN 日志 24 小时过期清理
      const expirationDate = new Date();
      expirationDate.setHours(expirationDate.getHours() - 24);

      const errResult = await this.prisma.scriptLog.deleteMany({
        where: {
          level: { in: ['WARN', 'ERROR'] },
          timestamp: {
            lt: expirationDate,
          },
        },
      });

      if (infoCleanup > 0 || errResult.count > 0) {
        this.logger.log(
          `[定时任务] 日志清理完成。清理INFO超限日志: ${infoCleanup} 行; 清理WARN/ERROR过期日志: ${errResult.count} 行`,
        );
      }
    } catch (err) {
      this.logger.error('[定时任务] 分级清理过期与超限历史日志出错:', err);
    }
  }
}
