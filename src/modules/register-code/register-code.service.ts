/**
 * @file: register-code.service.ts
 * @description: 注册激活码模块业务逻辑层。负责按卡种与应用批量制卡、客户端长连接鉴权激活、时长（正负）微调、以及设备物理解绑。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import { Injectable, BadRequestException, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TcpSocketService } from '../tcp-socket/tcp-socket.service';
import * as crypto from 'crypto';

@Injectable()
export class RegisterCodeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TcpSocketService))
    private readonly tcpSocketService: TcpSocketService,
  ) {}

  /**
   * 分页获取激活码列表并模糊检索
   */
  async findAll(page: number, limit: number, search?: string) {
    const skip = (page - 1) * limit;
    const where: any = {};

    if (search) {
      where.code = { contains: search, mode: 'insensitive' };
    }

    const [list, total] = await Promise.all([
      this.prisma.registerCode.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.registerCode.count({ where }),
    ]);

    // 转换列表模型对齐前端展示
    const formattedList = list.map((item) => {
      let devices = [];
      try {
        devices = typeof item.bindDevices === 'string'
          ? JSON.parse(item.bindDevices)
          : (item.bindDevices as any[]) || [];
      } catch (e) {
        devices = [];
      }

      const firstDevice = devices.length > 0 ? devices[0].deviceId : null;

      // 实时动态矫正过期状态
      let currentStatus = item.status;
      if (item.expireTime && new Date() > new Date(item.expireTime) && item.status !== 0) {
        currentStatus = 3; // 过期
      }

      // 状态文本转换，供前端渲染
      let statusStr = 'active';
      if (currentStatus === 0) statusStr = 'disabled';
      else if (currentStatus === 1) statusStr = 'unused';
      else if (currentStatus === 3) statusStr = 'expired';
      else if (currentStatus === 4) statusStr = 'full';

      return {
        id: item.id,
        code: item.code,
        appName: item.appName,
        cardType: item.cardType,
        durationMinutes: item.durationMinutes,
        maxActivations: item.maxActive,
        currentActivations: item.usedNum,
        rateLimit: 5, // 兼容原接口 QPS
        deviceId: firstDevice,
        status: statusStr,
        activatedAt: item.activatedAt ? item.activatedAt.toISOString() : null,
        expiresAt: item.expireTime ? item.expireTime.toISOString() : null,
        createdAt: item.createdAt.toISOString().split('T')[0],
        remark: item.remark,
      };
    });

    return { list: formattedList, total };
  }

  /**
   * 批量生成随机注册码（防碰撞规则）
   */
  async generate(data: {
    count: number;
    maxActivations: number;
    appName?: string;
    cardType: string;
    durationMinutes: number;
    remark?: string;
  }) {
    const count = Math.min(100, Math.max(1, data.count || 1));
    const maxActive = Math.max(1, data.maxActivations || 1);
    const appName = data.appName?.trim() || null;
    const cardType = data.cardType || 'YK';
    const durationMinutes = Math.max(1, data.durationMinutes || 43200);
    const remark = data.remark?.trim() || null;

    const generatedCodes = [];
    const baseChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆 O, 0, I, 1, l

    for (let i = 0; i < count; i++) {
      let code = '';
      let isUnique = false;

      while (!isUnique) {
        // 卡种前缀 + 12位安全随机字符
        let randomStr = '';
        for (let j = 0; j < 12; j++) {
          const randIdx = crypto.randomInt(0, baseChars.length);
          randomStr += baseChars[randIdx];
        }
        code = `${cardType}-${randomStr}`;

        const existing = await this.prisma.registerCode.findUnique({
          where: { code },
        });

        if (!existing) {
          isUnique = true;
        }
      }

      const newRecord = await this.prisma.registerCode.create({
        data: {
          code,
          appName,
          cardType,
          durationMinutes,
          maxActive,
          status: 1, // 1-正常可用（未激活）
          usedNum: 0,
          bindDevices: '[]',
          allowedApis: JSON.stringify(['api:data:fetch', 'script:run']),
          remark,
        },
      });

      generatedCodes.push(newRecord);
    }

    return {
      success: true,
      message: `成功批量生成 ${count} 个 [${cardType}] 授权注册码！`,
      list: generatedCodes,
    };
  }

  /**
   * 客户端免密登录激活校验状态机
   */
  async activateCode(code: string, deviceId: string, appName?: string) {
    const record = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    if (!record) {
      throw new BadRequestException('该注册码不存在！');
    }

    if (record.status === 0) {
      throw new BadRequestException('该注册码已被管理员禁用！');
    }

    // 应用关联校验
    if (record.appName && record.appName !== appName) {
      throw new BadRequestException(`此注册码限制专用于应用: [${record.appName}]`);
    }

    let devices: any[] = [];
    try {
      devices = typeof record.bindDevices === 'string'
        ? JSON.parse(record.bindDevices)
        : (record.bindDevices as any[]) || [];
    } catch (e) {
      devices = [];
    }

    const existingDevice = devices.find((d) => d.deviceId === deviceId);
    const now = new Date();

    // 1. 自动激活：如果该卡未激活，初始化激活和到期时间
    let updatedExpireTime = record.expireTime;
    let updatedActivatedAt = record.activatedAt;

    if (!record.activatedAt) {
      updatedActivatedAt = now;
      // 永久卡不设到期时间，或者设为 100 年后
      if (record.cardType === 'YJ') {
        updatedExpireTime = new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
      } else {
        updatedExpireTime = new Date(now.getTime() + record.durationMinutes * 60 * 1000);
      }
    }

    // 2. 到期校验
    if (updatedExpireTime && now > updatedExpireTime) {
      if (record.status !== 3) {
        await this.prisma.registerCode.update({
          where: { id: record.id },
          data: { status: 3 },
        });
      }
      throw new BadRequestException('该注册码已过期失效！');
    }

    // 3. 设备绑定数校验
    if (existingDevice) {
      existingDevice.lastActiveAt = now.toISOString();
    } else {
      if (record.usedNum >= record.maxActive) {
        throw new BadRequestException(`绑定设备数已达上限 (${record.maxActive}台)，请在控制台解绑旧设备！`);
      }
      devices.push({
        deviceId,
        activatedAt: now.toISOString(),
        lastActiveAt: now.toISOString(),
      });
    }

    const updatedUsedNum = devices.length;
    // 状态映射：若满载则 4-已满，否则为 2-使用中
    const nextStatus = updatedUsedNum >= record.maxActive ? 4 : 2;

    await this.prisma.registerCode.update({
      where: { id: record.id },
      data: {
        activatedAt: updatedActivatedAt,
        expireTime: updatedExpireTime,
        bindDevices: devices,
        usedNum: updatedUsedNum,
        status: nextStatus,
      },
    });

    return {
      codeId: record.id,
      expireTime: updatedExpireTime,
      maxActive: record.maxActive,
      usedNum: updatedUsedNum,
    };
  }

  /**
   * 管理员后台时间微调 (支持正负数)
   */
  async adjustDuration(id: string, minutes: number, reason: string) {
    const record = await this.prisma.registerCode.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('该注册码不存在！');
    }

    let updateData: any = {};
    const nowStr = new Date().toLocaleDateString('zh-CN');
    const adjustmentLog = `[${nowStr}] 调整 ${minutes > 0 ? '+' : ''}${minutes}分钟 (原因: ${reason || '无'})`;
    const newRemark = record.remark ? `${record.remark} | ${adjustmentLog}` : adjustmentLog;

    if (!record.activatedAt) {
      // 尚未激活，直接调整初始可用时长
      const nextDuration = Math.max(1, record.durationMinutes + minutes);
      updateData = {
        durationMinutes: nextDuration,
        remark: newRemark,
      };
    } else {
      // 已激活，加减截止时间 expireTime
      const currentExpireTime = record.expireTime ? new Date(record.expireTime) : new Date();
      const nextExpireTime = new Date(currentExpireTime.getTime() + minutes * 60 * 1000);

      // 判断调整后是否过期
      const isExpired = new Date() > nextExpireTime;
      let nextStatus = record.status;
      if (isExpired) {
        nextStatus = 3; // 已过期
      } else {
        // 如果原本是过期状态，恢复为正常使用/满载
        if (record.status === 3) {
          nextStatus = record.usedNum >= record.maxActive ? 4 : 2;
        }
      }

      updateData = {
        expireTime: nextExpireTime,
        status: nextStatus,
        remark: newRemark,
      };
    }

    return this.prisma.registerCode.update({
      where: { id },
      data: updateData,
    });
  }

  /**
   * 快捷启用/禁用
   */
  async updateStatus(id: string, status: 'active' | 'disabled') {
    const record = await this.prisma.registerCode.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('该注册码不存在！');
    }

    // 禁用置为 0，启用则根据其是否激活及使用状态动态归位
    let numericStatus = 1;
    if (status === 'disabled') {
      numericStatus = 0;
    } else {
      if (record.expireTime && new Date() > new Date(record.expireTime)) {
        numericStatus = 3; // 过期
      } else if (record.activatedAt) {
        numericStatus = record.usedNum >= record.maxActive ? 4 : 2;
      }
    }

    return this.prisma.registerCode.update({
      where: { id },
      data: {
        status: numericStatus,
      },
    });
  }

  /**
   * 解绑设备
   */
  async unbindDevice(id: string) {
    const record = await this.prisma.registerCode.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('该注册码不存在！');
    }

    let devices = [];
    try {
      devices = typeof record.bindDevices === 'string'
        ? JSON.parse(record.bindDevices)
        : (record.bindDevices as any[]) || [];
    } catch (e) {
      devices = [];
    }

    // 如果设备当前通过 TCP 长连接在线，下发 Kick 通知主动下线断连
    for (const dev of devices) {
      if (dev.deviceId) {
        this.tcpSocketService.forceKickDevice(dev.deviceId);
      }
    }

    return this.prisma.registerCode.update({
      where: { id },
      data: {
        bindDevices: '[]',
        usedNum: 0,
        status: record.activatedAt ? 2 : 1, // 若已激活归位使用中(2)，否则归位未激活(1)
      },
    });
  }

  /**
   * 物理作废注销
   */
  async delete(id: string) {
    const record = await this.prisma.registerCode.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('该注册码不存在！');
    }

    let devices = [];
    try {
      devices = typeof record.bindDevices === 'string'
        ? JSON.parse(record.bindDevices)
        : (record.bindDevices as any[]) || [];
    } catch (e) {
      devices = [];
    }

    // 强制踢线
    for (const dev of devices) {
      if (dev.deviceId) {
        this.tcpSocketService.forceKickDevice(dev.deviceId);
      }
    }

    return this.prisma.registerCode.delete({
      where: { id },
    });
  }
}
