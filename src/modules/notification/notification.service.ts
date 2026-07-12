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
import * as nodemailer from 'nodemailer';
import * as webpush from 'web-push';

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
  private lastCheckLicenseExpiryTime = 0;

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

    // 每 12 小时执行一次卡密剩余不足 3 天检测
    if (now - this.lastCheckLicenseExpiryTime > 43200000) {
      this.lastCheckLicenseExpiryTime = now;
      this.checkLicenseExpiry().catch((err) => {
        this.logger.error('执行卡密到期轮询监测定时任务异常:', err);
      });
    }

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

  /**
   * 自动扫描过期时间不足 3 天的卡密并发送警报
   */
  private async checkLicenseExpiry() {
    this.logger.log('[定时任务] 开始执行激活码到期剩余不足 3 天轮询检测...');
    try {
      // 1. 获取所有配置参数 (SMTP 与 VAPID 推送公私钥等)
      const settings = await this.prisma.systemSetting.findMany({
        where: {
          key: {
            in: [
              'mail_enabled',
              'smtp_host',
              'smtp_port',
              'smtp_user',
              'smtp_pass',
              'smtp_from',
              'alert_mail_enabled',
              'vapid_private_key',
              'vapid_public_key',
              'vapid_email',
            ],
          },
        },
      });

      const config: Record<string, string> = {};
      settings.forEach((item) => {
        config[item.key] = item.value;
      });

      // 动态配置 Web Push 公私钥
      const vapidPriv = config['vapid_private_key'];
      const vapidPub = config['vapid_public_key'];
      const vapidEmail = config['vapid_email'] || 'mailto:support@example.com';
      if (vapidPriv && vapidPub) {
        webpush.setVapidDetails(vapidEmail, vapidPub, vapidPriv);
      }

      // 2. 检索 3 天内过期的激活卡密 (排除永久卡 YJ)
      const threeDaysLater = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const regCodes = await this.prisma.registerCode.findMany({
        where: {
          expireTime: {
            gt: new Date(),
            lte: threeDaysLater,
          },
          cardType: {
            not: 'YJ',
          },
        },
      });

      this.logger.log(`[定时任务] 扫描到 3 天内即将过期的卡密数: ${regCodes.length} 张`);

      for (const regCode of regCodes) {
        const alertConfig = (regCode.alertConfig as any) || {};
        const expireNotice = alertConfig.expireNotice !== false; // 默认开启
        const expireNotified = alertConfig.expireNotified === true; // 本轮已发过

        if (!expireNotice || expireNotified) {
          continue;
        }

        try {
          await this.triggerExpiryAlert(regCode, config);
        } catch (err: any) {
          this.logger.error(`卡密 [${regCode.code}] 发送到期提醒失败:`, err);
        }
      }
    } catch (err: any) {
      this.logger.error('执行激活码到期扫描发生异常:', err);
    }
  }

  /**
   * 执行单个卡密到期通知行为并更新标记
   */
  private async triggerExpiryAlert(regCode: any, config: Record<string, string>) {
    const code = regCode.code;
    const expireTimeStr = new Date(regCode.expireTime).toLocaleString('zh-CN');

    // 1. 发射系统通知到大屏
    await this.createNotification({
      title: '⚠️ 激活卡密即将到期',
      content: `卡密 [${code}] 将于 [${expireTimeStr}] 到期（剩余不足3天），为了不影响正常挂机，请及时续费充值。`,
      level: 'WARN',
      type: 'license_expiry_warning',
      registerCode: code,
    });

    // 2. 发送邮件提醒
    const alertMailEnabled = config['alert_mail_enabled'] === 'true';
    const alertEmail = regCode.alertEmail;
    if (alertMailEnabled && alertEmail) {
      await this.sendExpiryEmail(alertEmail, code, expireTimeStr, config);
    }

    // 3. 发送桌面 PWA 通知
    const subscriptions = (regCode.pushSubscriptions as any[]) || [];
    const vapidPriv = config['vapid_private_key'];
    const vapidPub = config['vapid_public_key'];
    if (vapidPriv && vapidPub && subscriptions.length > 0) {
      await this.sendExpiryWebPush(subscriptions, code, expireTimeStr);
    }

    // 4. 修改 alertConfig 字段，标记 expireNotified 为 true 防重复提醒
    const alertConfig = regCode.alertConfig
      ? { ...(regCode.alertConfig as any), expireNotified: true }
      : { expireNotified: true };

    await this.prisma.registerCode.update({
      where: { id: regCode.id },
      data: { alertConfig },
    });
  }

  /**
   * 通过 SMTP 邮件向卡密配置的邮箱推送过期警报
   */
  private async sendExpiryEmail(
    alertEmail: string,
    code: string,
    expireTimeStr: string,
    config: Record<string, string>,
  ) {
    try {
      const mailEnabled = config['mail_enabled'] === 'true';
      const smtpHost = config['smtp_host'];
      const smtpPort = config['smtp_port'];
      const smtpUser = config['smtp_user'];
      const smtpPass = config['smtp_pass'];
      const smtpFrom = config['smtp_from'] || smtpUser;

      if (!mailEnabled || !smtpHost || !smtpPort || !smtpUser || !smtpPass) {
        return;
      }

      const port = parseInt(smtpPort, 10) || 465;
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port,
        secure: port === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      const toEmails = alertEmail
        .split(/[;,]/)
        .map((e) => e.trim())
        .filter(Boolean);
      if (toEmails.length === 0) return;

      await transporter.sendMail({
        from: smtpFrom,
        to: toEmails,
        subject: '【小宝修仙】卡密即将到期预警通知',
        html: `
          <div style="padding: 24px; font-family: sans-serif; background-color: #f8fafc; color: #1e293b; border-radius: 8px;">
            <h2 style="color: #ea580c; font-weight: bold; margin-bottom: 16px;">小宝修仙卡密到期预警</h2>
            <p style="font-size: 14px; line-height: 1.5;">您绑定的卡密即将于 3 天内过期，为了不影响您的设备正常挂机和监控，请及时关注：</p>
            <div style="margin: 20px 0; padding: 16px; background-color: #fff7ed; border-left: 4px solid #ea580c; border-radius: 4px;">
              <p style="margin: 0; font-size: 14px;"><strong>卡密激活码:</strong> <span style="font-family: monospace;">${code}</span></p>
              <p style="margin: 6px 0 0 0; font-size: 14px;"><strong>到期截止时间:</strong> <span style="color: #ea580c; font-weight: bold;">${expireTimeStr}</span></p>
            </div>
            <p style="font-size: 12px; color: #64748b; margin-top: 24px;">本邮件为系统自动投递，如已完成续费充值，请忽略此提醒。</p>
          </div>
        `,
      });
      this.logger.log(`[SMTP] 到期预警邮件已发送至: ${toEmails.join(', ')}`);
    } catch (err) {
      this.logger.error('[SMTP] 发送卡密到期邮件报警出错:', err);
    }
  }

  /**
   * 推送 PWA 桌面弹窗通知
   */
  private async sendExpiryWebPush(
    subscriptions: any[],
    code: string,
    expireTimeStr: string,
  ) {
    const payload = JSON.stringify({
      title: '⚠️ 卡密即将到期提醒',
      body: `您的卡密 [${code}] 将于 [${expireTimeStr}] 过期（剩余不足3天），为了不影响挂机，请及时关注。`,
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-192x192.png',
      data: {
        url: '/user/settings',
      },
    });

    const promises = subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err: any) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          this.logger.warn(`到期提醒中检测到 PWA 订阅失效，准备自动清除: ${sub.endpoint}`);
          const fresh = await this.prisma.registerCode.findUnique({
            where: { code },
            select: { id: true, pushSubscriptions: true },
          });
          if (fresh) {
            const freshSubs = (fresh.pushSubscriptions as any[]) || [];
            const filtered = freshSubs.filter((s: any) => s.endpoint !== sub.endpoint);
            await this.prisma.registerCode.update({
              where: { id: fresh.id },
              data: { pushSubscriptions: filtered },
            }).catch(() => {});
          }
        } else {
          this.logger.error(`向 ${sub.endpoint} 发送卡密到期 Web Push 失败:`, err);
        }
      }
    });
    await Promise.all(promises);
  }
}
