import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as webpush from 'web-push';

@Injectable()
export class DebugService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 1. 快速创建用于测试的临时卡密 (以 XB-DEBUG- 开头)
   */
  async createTempCode() {
    const randomSuffix = Math.random()
      .toString(36)
      .substring(2, 8)
      .toUpperCase();
    const testCode = `XB-DEBUG-${randomSuffix}`;

    const record = await this.prisma.registerCode.create({
      data: {
        code: testCode,
        cardType: 'YK',
        durationMinutes: 43200, // 30天
        maxActive: 1,
        status: 1, // 正常可用
        bindDevices: '[]',
        allowedApis: '[]',
      },
    });

    return {
      success: true,
      message: `临时测试卡密 ${testCode} 创建成功！`,
      data: record,
    };
  }

  /**
   * 2. 清理系统内所有以 XB-DEBUG- 开头的测试脏数据
   */
  async cleanup() {
    // 找出所有以 XB-DEBUG- 开头的卡密
    const testCodes = await this.prisma.registerCode.findMany({
      where: {
        code: {
          startsWith: 'XB-DEBUG-',
        },
      },
      select: {
        id: true,
        code: true,
      },
    });

    const ids = testCodes.map((c) => c.id);
    const codeList = testCodes.map((c) => c.code);

    if (ids.length > 0) {
      // 因为在 Prisma schema 中 RegisterCodeDevice 关联了 RegisterCode 并且配置了 onDelete: Cascade
      // 所以我们直接物理删除 RegisterCode，相关的 RegisterCodeDevice 记录将被数据库自动级联物理删除
      await this.prisma.registerCode.deleteMany({
        where: {
          id: {
            in: ids,
          },
        },
      });
    }

    return {
      success: true,
      message: `已物理清理系统内 ${codeList.length} 个临时调试测试卡密及其全部设备物理绑定关系`,
      cleanedCodes: codeList,
    };
  }

  /**
   * 3. 发送测试桌面推送通知
   */
  async sendTestPush(code: string, title?: string, body?: string) {
    const record = await this.prisma.registerCode.findUnique({
      where: { code },
      select: { pushSubscriptions: true },
    });

    if (!record) {
      return {
        success: false,
        message: `卡密 [${code}] 不存在，请检查卡密输入是否正确。`,
      };
    }

    const subscriptions =
      (record.pushSubscriptions as unknown as { endpoint: string }[]) || [];
    if (subscriptions.length === 0) {
      return {
        success: false,
        message: `卡密 [${code}] 当前未在任何设备/浏览器上订阅桌面推送。请在用户端先允许通知并勾选“启用桌面推送”开关再试。`,
      };
    }

    const payload = JSON.stringify({
      title: title || '🧪 小宝推送调试测试',
      body:
        body ||
        '这是一条来自管理端调试模块的测试推送通知，看到此气泡说明推送通道工作正常！',
      icon: '/icons/icon-192x192.png',
      badge: '/icons/icon-192x192.png',
      data: {
        url: `/user/settings`,
      },
    });

    let successCount = 0;
    let failCount = 0;

    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(sub, payload);
        successCount++;
      } catch (err: unknown) {
        failCount++;
        // 自动剔除失效凭证
        const error = err as { statusCode?: number };
        if (error.statusCode === 410 || error.statusCode === 404) {
          const fresh = await this.prisma.registerCode.findUnique({
            where: { code },
            select: { pushSubscriptions: true },
          });
          if (fresh) {
            const freshSubs =
              (fresh.pushSubscriptions as unknown as {
                endpoint: string;
              }[]) || [];
            const filtered = freshSubs.filter(
              (s) => s.endpoint !== sub.endpoint,
            );
            await this.prisma.registerCode
              .update({
                where: { code },
                data: { pushSubscriptions: filtered },
              })
              .catch(() => {});
          }
        }
      }
    }

    return {
      success: true,
      message: `推送成功！共尝试推送 ${subscriptions.length} 个订阅设备，成功 ${successCount} 个，失败已剔除 ${failCount} 个。`,
      successCount,
      failCount,
    };
  }
}
