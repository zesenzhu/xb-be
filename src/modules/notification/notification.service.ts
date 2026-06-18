import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Subject } from 'rxjs';
import { SystemNotification } from '@prisma/client';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);

  // SSE 消息广播 Subject
  public readonly notificationBroadcaster$ = new Subject<SystemNotification>();

  private monitorInterval: NodeJS.Timeout | null = null;

  // 告警冷喷控制（毫秒）
  private lastMemoryAlertTime = 0;
  private lastDiskAlertTime = 0;
  private lastLogVolumeAlertTime = 0;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.logger.log(
      '初始化系统通知与监控服务，启动 2 分钟服务器健康轮询任务...',
    );
    // 启动定时任务：每 2 分钟执行一次系统资源监测
    this.monitorInterval = setInterval(() => {
      this.checkServerHealth().catch((err) => {
        this.logger.error('执行服务器资源监测定时任务出错:', err);
      });
    }, 120000); // 2 分钟

    // 启动时延迟 10 秒进行首次检测，防止启动时瞬间负载高误报
    setTimeout(() => {
      this.checkServerHealth().catch((err) => {
        this.logger.error('启动首次执行服务器资源监测出错:', err);
      });
    }, 10000);
  }

  onModuleDestroy() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * 创建系统通知并实时广播
   */
  async createNotification(data: {
    title: string;
    content: string;
    level: 'INFO' | 'WARN' | 'ERROR';
    type: string;
    deviceId?: string;
    deviceName?: string;
    registerCode?: string;
  }) {
    try {
      const notification = await this.prisma.systemNotification.create({
        data: {
          title: data.title,
          content: data.content,
          level: data.level,
          type: data.type,
          deviceId: data.deviceId || null,
          deviceName: data.deviceName || null,
          registerCode: data.registerCode || null,
        },
      });

      // 实时向订阅了 SSE 的客户端广播新生成的通知
      this.notificationBroadcaster$.next(notification);
      this.logger.log(
        `[系统通知中心] 生成新通知 [${data.level}] ${data.title}`,
      );
      return notification;
    } catch (err) {
      this.logger.error('写入系统通知失败:', err);
    }
  }

  /**
   * 获取所有通知列表 (支持分页和未读过滤)
   */
  async findAll(query: {
    isRead?: boolean;
    level?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.isRead !== undefined) {
      where.isRead = query.isRead;
    }
    if (query.level) {
      where.level = query.level;
    }

    const [list, total] = await Promise.all([
      this.prisma.systemNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.systemNotification.count({ where }),
    ]);

    return {
      list,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 标记为已读
   */
  async markAsRead(ids: string[]) {
    if (!ids || ids.length === 0) return { count: 0 };
    return this.prisma.systemNotification.updateMany({
      where: {
        id: { in: ids },
      },
      data: {
        isRead: true,
      },
    });
  }

  /**
   * 全部标记为已读
   */
  async markAllAsRead() {
    return this.prisma.systemNotification.updateMany({
      where: {
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });
  }

  /**
   * 获取未读通知总数
   */
  async getUnreadCount() {
    const count = await this.prisma.systemNotification.count({
      where: {
        isRead: false,
      },
    });
    return { count };
  }

  /**
   * 服务器状态与日志体积的核心定时检测逻辑
   */
  private async checkServerHealth() {
    const now = Date.now();

    // 1. 内存监测 (冷喷 1 小时)
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memoryUsageRate = (usedMem / totalMem) * 100;

    if (memoryUsageRate > 90) {
      if (now - this.lastMemoryAlertTime > 3600000) {
        // 1 小时冷喷
        this.lastMemoryAlertTime = now;
        const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(1);
        const freeGB = (freeMem / 1024 / 1024 / 1024).toFixed(1);

        await this.createNotification({
          title: '🚨 服务器内存过载警报',
          content: `系统当前内存占用率已达 ${memoryUsageRate.toFixed(1)}%。总内存: ${totalGB}GB, 剩余可用: ${freeGB}GB。请及时排查是否发生 Node 内存泄漏或后台进程积压。`,
          level: 'ERROR',
          type: 'server_memory_high',
        });
      }
    }

    // 2. 磁盘占用监测 (冷喷 2 小时)
    try {
      const { stdout } = await execAsync('df -h / | tail -1');
      const parts = stdout.trim().split(/\s+/);
      const usePercentPart = parts.find((p) => p.includes('%'));
      if (usePercentPart) {
        const diskUsageRate =
          parseInt(usePercentPart.replace('%', ''), 10) || 0;
        if (diskUsageRate > 90) {
          if (now - this.lastDiskAlertTime > 7200000) {
            // 2 小时冷喷
            this.lastDiskAlertTime = now;
            await this.createNotification({
              title: '🚨 服务器磁盘空间不足',
              content: `服务器根分区磁盘占用率已达 ${diskUsageRate}%，剩余可用磁盘容量危急！请及时登录服务器清理运行日志或多余历史数据。`,
              level: 'ERROR',
              type: 'server_disk_high',
            });
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`获取磁盘监控数据失败: ${err.message}`);
    }

    // 3. 运行日志库体积监测 (冷喷 24 小时)
    try {
      const logTotalCount = await this.prisma.scriptLog.count();
      if (logTotalCount > 1000000) {
        // 超过 100 万条
        if (now - this.lastLogVolumeAlertTime > 86400000) {
          // 24 小时冷喷
          this.lastLogVolumeAlertTime = now;
          await this.createNotification({
            title: '⚠️ 系统日志库膨胀预警',
            content: `当前数据库中 ScriptLog 日志总数已达 ${logTotalCount.toLocaleString()} 条。日志库过度膨胀会严重影响数据库读写性能与磁盘空间，建议管理员及时前往控制面板或使用清理工具清理历史过期日志。`,
            level: 'WARN',
            type: 'log_volume_high',
          });
        }
      }
    } catch (err: any) {
      this.logger.error(`日志库行数统计异常: ${err.message}`);
    }
  }
}
