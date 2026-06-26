/**
 * @file: register-code.service.ts
 * @description: 注册激活码模块业务逻辑层。负责按卡种与应用批量制卡、客户端长连接鉴权激活、时长（正负）微调、以及设备物理解绑。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TcpSocketService } from '../tcp-socket/tcp-socket.service';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';
import * as XLSX from 'xlsx';
import { NotificationService } from '../notification/notification.service';

export interface BindDeviceItem {
  deviceId: string;
  activatedAt: string;
  lastActiveAt: string;
  name?: string;
  model?: string;
  os?: string;
  osVersion?: string;
  resolution?: string;
  dpi?: number;
  isRoot?: number;
  ip?: string;
  battery?: number;
  deviceType?: string;
  frontApp?: string;
  isLocked?: number;
  vpnStatus?: number;
}

@Injectable()
export class RegisterCodeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TcpSocketService))
    private readonly tcpSocketService: TcpSocketService,
    private readonly notificationService: NotificationService,
  ) {}

  /**
   * 分页获取激活码列表并模糊检索
   */
  async findAll(
    page: number,
    limit: number,
    options?: {
      code?: string;
      appName?: string;
      cardType?: string;
      deviceId?: string;
      status?: string;
      expireStart?: string;
      expireEnd?: string;
      isEnabled?: boolean;
      source?: string;
    },
  ) {
    const skip = (page - 1) * limit;
    const where: Prisma.RegisterCodeWhereInput = {};

    if (options?.source) {
      where.source = options.source;
    }

    if (options?.code) {
      where.code = { contains: options.code, mode: 'insensitive' };
    }

    if (options?.appName) {
      if (options.appName === 'general') {
        where.appName = null;
      } else {
        where.appName = { contains: options.appName, mode: 'insensitive' };
      }
    }

    if (options?.cardType) {
      where.cardType = options.cardType;
    }

    if (options?.deviceId) {
      where.bindDevices = {
        array_contains: [{ deviceId: options.deviceId }],
      };
    }

    if (options?.status) {
      let statusNum: number | undefined;
      switch (options.status) {
        case 'disabled':
          statusNum = 0;
          break;
        case 'unused':
          statusNum = 1;
          break;
        case 'active':
          statusNum = 2;
          break;
        case 'expired':
          statusNum = 3;
          break;
        case 'full':
          statusNum = 4;
          break;
      }
      if (statusNum !== undefined) {
        where.status = statusNum;
      }
    }

    if (options?.isEnabled !== undefined) {
      if (options.isEnabled) {
        where.status = { not: 0 };
      } else {
        where.status = 0;
      }
    }

    if (options?.expireStart || options?.expireEnd) {
      const expireFilter: Prisma.DateTimeNullableFilter = {};
      if (options.expireStart) {
        expireFilter.gte = new Date(options.expireStart);
      }
      if (options.expireEnd) {
        expireFilter.lte = new Date(options.expireEnd);
      }
      where.expireTime = expireFilter;
    }

    const [list, total] = await Promise.all([
      this.prisma.registerCode.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.registerCode.count({ where }),
    ]);

    // 转换列表模型对齐前端展示
    const formattedList = list.map((item) => {
      let devices: BindDeviceItem[] = [];
      try {
        devices =
          typeof item.bindDevices === 'string'
            ? JSON.parse(item.bindDevices)
            : (item.bindDevices as unknown as BindDeviceItem[]) || [];
      } catch (e) {
        devices = [];
      }

      const firstDevice = devices.length > 0 ? devices[0].deviceId : null;

      // 实时动态矫正过期状态
      let currentStatus = item.status;
      if (
        item.expireTime &&
        new Date() > new Date(item.expireTime) &&
        item.status !== 0
      ) {
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
        deviceIds: devices.map((d) => d.deviceId),
        bindDevices: devices,
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
          source: 'CREATE',
        },
      });

      generatedCodes.push(newRecord);
      await this.recordActionLog(
        newRecord.code,
        'GENERATE',
        `批量自动制卡生成。关联应用: ${appName || '通用'} | 时长: ${durationMinutes}分钟`,
      );
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
  async activateCode(
    code: string,
    deviceId: string,
    appName?: string,
    deviceInfo?: any,
  ) {
    if (deviceInfo && typeof deviceInfo === 'object') {
      const info = deviceInfo as Record<string, any>;
      if (info.ip === 'error' || info.ip === 'null') {
        info.ip = '0.0.0.0';
      }
    }
    // 前置拉黑拦截
    const isBlacklisted = await this.prisma.registerCodeBlacklist.findFirst({
      where: {
        registerCode: { code },
        deviceId,
      },
    });
    if (isBlacklisted) {
      await this.notificationService.createNotification({
        title: '🛡️ 黑名单拦截警告',
        content: `黑名单设备 [${deviceId}] 尝试激活卡密 [${code}] 被系统拦截。`,
        level: 'ERROR',
        type: 'auth_blacklist',
        deviceId,
        registerCode: code,
      });
      throw new BadRequestException('该设备已被禁止绑定此授权码！');
    }

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
      throw new BadRequestException(
        `此注册码限制专用于应用: [${record.appName}]`,
      );
    }

    let devices: BindDeviceItem[] = [];
    try {
      devices =
        typeof record.bindDevices === 'string'
          ? JSON.parse(record.bindDevices)
          : (record.bindDevices as unknown as BindDeviceItem[]) || [];
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
        updatedExpireTime = new Date(
          now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000,
        );
      } else {
        updatedExpireTime = new Date(
          now.getTime() + record.durationMinutes * 60 * 1000,
        );
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
      await this.notificationService.createNotification({
        title: '⚠️ 尝试使用已过期卡密',
        content: `设备 [${deviceId}] 尝试使用已过期的卡密 [${code}] 进行鉴权，连接已被拒绝。`,
        level: 'WARN',
        type: 'code_expired',
        deviceId,
        registerCode: code,
      });
      throw new BadRequestException('该注册码已过期失效！');
    }

    // 3. 设备绑定数校验
    if (existingDevice) {
      existingDevice.lastActiveAt = now.toISOString();
      if (deviceInfo) {
        existingDevice.name = deviceInfo.name || existingDevice.name;
        existingDevice.model = deviceInfo.model || existingDevice.model;
        existingDevice.os = deviceInfo.os || existingDevice.os;
        existingDevice.osVersion =
          deviceInfo.osVersion || existingDevice.osVersion;
        existingDevice.resolution =
          deviceInfo.resolution || existingDevice.resolution;
        existingDevice.dpi =
          deviceInfo.dpi !== undefined ? deviceInfo.dpi : existingDevice.dpi;
        existingDevice.isRoot =
          deviceInfo.isRoot !== undefined
            ? deviceInfo.isRoot
            : existingDevice.isRoot;
        existingDevice.ip = deviceInfo.ip || existingDevice.ip;
        existingDevice.battery =
          deviceInfo.battery !== undefined
            ? deviceInfo.battery
            : existingDevice.battery;
        existingDevice.deviceType =
          deviceInfo.deviceType || existingDevice.deviceType;
        existingDevice.frontApp =
          deviceInfo.frontApp || existingDevice.frontApp;
        existingDevice.isLocked =
          deviceInfo.isLocked !== undefined
            ? deviceInfo.isLocked
            : existingDevice.isLocked;
        existingDevice.vpnStatus =
          deviceInfo.vpnStatus !== undefined
            ? deviceInfo.vpnStatus
            : existingDevice.vpnStatus;
      }
    } else {
      if (record.usedNum >= record.maxActive) {
        await this.notificationService.createNotification({
          title: '🚨 激活卡授权设备超限',
          content: `设备 [${deviceId}] 尝试绑定卡密 [${code}] 失败。当前已绑定 ${record.usedNum} 台设备，已达卡密授权上限 ${record.maxActive} 台。`,
          level: 'ERROR',
          type: 'auth_overflow',
          deviceId,
          registerCode: code,
        });
        throw new BadRequestException(
          `绑定设备数已达上限 (${record.maxActive}台)，请在控制台解绑旧设备！`,
        );
      }
      devices.push({
        deviceId,
        activatedAt: now.toISOString(),
        lastActiveAt: now.toISOString(),
        name: deviceInfo?.name,
        model: deviceInfo?.model,
        os: deviceInfo?.os,
        osVersion: deviceInfo?.osVersion,
        resolution: deviceInfo?.resolution,
        dpi: deviceInfo?.dpi,
        isRoot: deviceInfo?.isRoot,
        ip: deviceInfo?.ip,
        battery: deviceInfo?.battery,
        deviceType: deviceInfo?.deviceType,
        frontApp: deviceInfo?.frontApp,
        isLocked: deviceInfo?.isLocked,
        vpnStatus: deviceInfo?.vpnStatus,
      });
    }

    const updatedUsedNum = devices.length;
    // 状态映射：若满载则 4-已满，否则为 2-使用中
    const nextStatus = updatedUsedNum >= record.maxActive ? 4 : 2;

    if (!existingDevice) {
      // 全新设备物理绑定，开启事务同步维护关系表与主表
      await this.prisma.$transaction(async (tx) => {
        await tx.registerCodeDevice.create({
          data: {
            registerCodeId: record.id,
            deviceId,
          },
        });
        await tx.registerCode.update({
          where: { id: record.id },
          data: {
            activatedAt: updatedActivatedAt,
            expireTime: updatedExpireTime,
            bindDevices: devices as unknown as Prisma.InputJsonValue,
            usedNum: updatedUsedNum,
            status: nextStatus,
          },
        });
      });

      // 绑定成功后发送提醒
      if (!record.activatedAt) {
        // 首次激活
        await this.notificationService.createNotification({
          title: '🎉 卡密首次激活成功',
          content: `卡密 [${code}] 已被设备 [${deviceInfo?.name || deviceId}] 首次激活并绑定。`,
          level: 'INFO',
          type: 'code_activated',
          deviceId,
          deviceName: deviceInfo?.name || null,
          registerCode: code,
        });
      } else {
        // 新绑定设备
        await this.notificationService.createNotification({
          title: '📱 授权卡绑定新设备',
          content: `卡密 [${code}] 成功绑定了新设备 [${deviceInfo?.name || deviceId}]。当前绑定数: ${updatedUsedNum}/${record.maxActive}。`,
          level: 'INFO',
          type: 'device_bind',
          deviceId,
          deviceName: deviceInfo?.name || null,
          registerCode: code,
        });
      }
    } else {
      // 已绑定过的老设备登录直接更新主表活跃状态即可
      await this.prisma.registerCode.update({
        where: { id: record.id },
        data: {
          activatedAt: updatedActivatedAt,
          expireTime: updatedExpireTime,
          bindDevices: devices as unknown as Prisma.InputJsonValue,
          usedNum: updatedUsedNum,
          status: nextStatus,
        },
      });
    }

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

    let updateData: Prisma.RegisterCodeUpdateInput = {};
    const nowStr = new Date().toLocaleDateString('zh-CN');
    const adjustmentLog = `[${nowStr}] 调整 ${minutes > 0 ? '+' : ''}${minutes}分钟 (原因: ${reason || '无'})`;
    const newRemark = record.remark
      ? `${record.remark} | ${adjustmentLog}`
      : adjustmentLog;

    if (!record.activatedAt) {
      // 尚未激活，直接调整初始可用时长
      const nextDuration = Math.max(1, record.durationMinutes + minutes);
      updateData = {
        durationMinutes: nextDuration,
        remark: newRemark,
      };
    } else {
      // 已激活，加减截止时间 expireTime
      const currentExpireTime = record.expireTime
        ? new Date(record.expireTime)
        : new Date();
      const nextExpireTime = new Date(
        currentExpireTime.getTime() + minutes * 60 * 1000,
      );

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

    const updated = await this.prisma.registerCode.update({
      where: { id },
      data: updateData,
    });
    await this.recordActionLog(
      updated.code,
      'ADJUST',
      `微调时长 ${minutes > 0 ? '+' : ''}${minutes}分钟。原因: ${reason || '无'}`,
    );
    return updated;
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

    const updated = await this.prisma.registerCode.update({
      where: { id },
      data: {
        status: numericStatus,
      },
    });
    await this.recordActionLog(
      updated.code,
      status === 'disabled' ? 'DISABLE' : 'ENABLE',
      status === 'disabled' ? '禁用注册码' : '启用注册码',
    );
    return updated;
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
      devices =
        typeof record.bindDevices === 'string'
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

    // 清空物理绑定关联表中的全部设备数据
    await this.prisma.registerCodeDevice.deleteMany({
      where: { registerCodeId: id },
    });

    const updated = await this.prisma.registerCode.update({
      where: { id },
      data: {
        bindDevices: '[]',
        usedNum: 0,
        status: record.activatedAt ? 2 : 1, // 若已激活归位使用中(2)，否则归位未激活(1)
      },
    });
    await this.recordActionLog(
      updated.code,
      'UNBIND',
      '强行解绑该卡所有绑定物理设备',
    );
    await this.notificationService.createNotification({
      title: '🔓 授权设备强制解绑',
      content: `已成功强制解绑卡密 [${updated.code}] 下的所有物理设备。`,
      level: 'INFO',
      type: 'device_unbind',
      registerCode: updated.code,
    });
    return updated;
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
      devices =
        typeof record.bindDevices === 'string'
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

    const deleted = await this.prisma.registerCode.delete({
      where: { id },
    });
    await this.recordActionLog(deleted.code, 'DELETE', '物理注销作废该卡密');
    return deleted;
  }

  async updateConfig(id: string, appId: string | null, allowedFeatures: string[]) {
    const record = await this.prisma.registerCode.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('该注册码不存在！');
    }

    let appName: string | null = null;
    if (appId) {
      const app = await this.prisma.app.findUnique({ where: { id: appId } });
      if (!app) {
        throw new NotFoundException('所选应用不存在！');
      }
      appName = app.name;
    }

    const updated = await this.prisma.registerCode.update({
      where: { id },
      data: {
        appId,
        appName, // 冗余保存 appName 兼容旧版客户端
        allowedFeatures: allowedFeatures as Prisma.InputJsonValue,
      },
    });

    await this.recordActionLog(
      updated.code,
      'ADJUST',
      `更新激活码应用与权限配置。应用 ID: ${appId || '通用'}，权限数: ${allowedFeatures.length}`,
    );

    return updated;
  }

  async batchUpdateConfig(ids: string[], appId: string | null, allowedFeatures: string[]) {
    let appName: string | null = null;
    if (appId) {
      const app = await this.prisma.app.findUnique({ where: { id: appId } });
      if (!app) {
        throw new NotFoundException('所选应用不存在！');
      }
      appName = app.name;
    }

    const records = await this.prisma.registerCode.findMany({
      where: { id: { in: ids } },
      select: { code: true, id: true }
    });

    const result = await this.prisma.registerCode.updateMany({
      where: { id: { in: ids } },
      data: {
        appId,
        appName,
        allowedFeatures: allowedFeatures as Prisma.InputJsonValue,
      },
    });

    // 记录日志
    for (const record of records) {
      await this.recordActionLog(
        record.code,
        'ADJUST',
        `批量更新激活码应用与权限配置。应用 ID: ${appId || '通用'}，权限数: ${allowedFeatures.length}`,
      );
    }

    return result;
  }

  /**
   * 获取所有注册码绑定的物理设备列表 (供管理员大屏拉取)
   */
  async findAllBoundDevices() {
    const codes = await this.prisma.registerCode.findMany({
      where: {
        usedNum: { gt: 0 },
      },
      select: {
        code: true,
        bindDevices: true,
        appName: true,
      },
    });

    const deviceMap = new Map<
      string,
      BindDeviceItem & { licenseBound: string; appName?: string }
    >();

    for (const item of codes) {
      let devicesList: BindDeviceItem[] = [];
      try {
        devicesList =
          typeof item.bindDevices === 'string'
            ? (JSON.parse(item.bindDevices) as BindDeviceItem[])
            : (item.bindDevices as unknown as BindDeviceItem[]) || [];
      } catch (e) {
        devicesList = [];
      }

      for (const dev of devicesList) {
        if (!dev.deviceId) continue;
        const exists = deviceMap.get(dev.deviceId);
        if (
          !exists ||
          (dev.lastActiveAt &&
            exists.lastActiveAt &&
            new Date(dev.lastActiveAt) > new Date(exists.lastActiveAt))
        ) {
          deviceMap.set(dev.deviceId, {
            ...dev,
            licenseBound: item.code,
            appName: item.appName || '通用',
          });
        }
      }
    }

    const list = Array.from(deviceMap.values()).map((dev) => {
      const isOnline = this.tcpSocketService.isDeviceOnline(dev.deviceId);
      const onlineIp = isOnline
        ? this.tcpSocketService.getDeviceRemoteIp(dev.deviceId)
        : '';
      const connection = this.tcpSocketService.getActiveConnection(
        dev.deviceId,
      );
      const devInfo = connection?.deviceInfo || dev;

      const maskedId = dev.deviceId.slice(0, 8);

      return {
        id: dev.deviceId,
        name: devInfo.name || `设备 (${maskedId})`,
        model: devInfo.model || '未知型号',
        os: devInfo.os || 'ios',
        osVersion: devInfo.osVersion || '未知版本',
        resolution: devInfo.resolution || '未知分辨率',
        dpi: devInfo.dpi || 0,
        isRoot: devInfo.isRoot === 1,
        ip: onlineIp || devInfo.ip || '127.0.0.1',
        status: isOnline ? 'online' : 'offline',
        battery: devInfo.battery !== undefined ? devInfo.battery : 100,
        deviceType: devInfo.deviceType || 'unknown',
        frontApp: devInfo.frontApp || 'unknown',
        isLocked: devInfo.isLocked === 1,
        vpnStatus: devInfo.vpnStatus === 1,
        scriptMemory: (devInfo as any).scriptMemory || 0,
        isSwitchingAccount: (devInfo as any).isSwitchingAccount === 1,
        currentTask: (devInfo as any).currentTask || '离线/空闲',
        currentAccount: (devInfo as any).currentAccount || '未登录',
        runningTime: (devInfo as any).runningTime || 0,
        licenseBound: dev.licenseBound,
        appName: dev.appName || '通用',
        heartbeatsCount: isOnline ? connection?.pingCount || 0 : 0,
        activatedAt: dev.activatedAt || null,
        lastActiveAt: dev.lastActiveAt || null,
        connectedAt:
          isOnline && connection?.connectedAt
            ? connection.connectedAt.toISOString()
            : null,
      };
    });

    return list;
  }

  /**
   * 获取激活码绑定的设备信息列表及其实时在线状态
   */
  async findBoundDevices(code: string) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    if (!regCode) {
      throw new NotFoundException('注册激活码不存在');
    }

    let bindDevices: BindDeviceItem[] = [];
    try {
      bindDevices =
        typeof regCode.bindDevices === 'string'
          ? (JSON.parse(regCode.bindDevices) as BindDeviceItem[])
          : (regCode.bindDevices as unknown as BindDeviceItem[]) || [];
    } catch (e) {
      bindDevices = [];
    }

    const list = await Promise.all(
      bindDevices.map(async (dev) => {
        const isOnline = this.tcpSocketService.isDeviceOnline(dev.deviceId);
        const onlineIp = isOnline
          ? this.tcpSocketService.getDeviceRemoteIp(dev.deviceId)
          : '';
        const connection = this.tcpSocketService.getActiveConnection(
          dev.deviceId,
        );
        const devInfo = connection?.deviceInfo || dev;

        // 对每台设备查询最新的一条 ERROR 级别日志
        const lastErrorLog = await this.prisma.scriptLog.findFirst({
          where: {
            deviceId: dev.deviceId,
            level: 'ERROR',
          },
          orderBy: {
            timestamp: 'desc',
          },
          select: {
            message: true,
            timestamp: true,
          },
        });

        return {
          id: dev.deviceId,
          name: devInfo.name || `设备终端 (${dev.deviceId.slice(0, 8)})`,
          model: devInfo.model || '未知型号',
          os: devInfo.os || 'ios',
          osVersion: devInfo.osVersion || '未知版本',
          resolution: devInfo.resolution || '未知分辨率',
          dpi: devInfo.dpi || 0,
          isRoot: devInfo.isRoot === 1,
          battery: devInfo.battery !== undefined ? devInfo.battery : 100,
          ip:
            onlineIp && onlineIp !== 'error' && onlineIp !== 'null'
              ? onlineIp
              : devInfo.ip === 'error' || devInfo.ip === 'null'
                ? '0.0.0.0'
                : devInfo.ip || '127.0.0.1',
          status: isOnline ? 'online' : 'offline',
          deviceType: devInfo.deviceType || 'unknown',
          frontApp: devInfo.frontApp || 'unknown',
          isLocked: devInfo.isLocked === 1,
          vpnStatus: devInfo.vpnStatus === 1,
          scriptMemory: (devInfo as any).scriptMemory || 0,
          isSwitchingAccount: (devInfo as any).isSwitchingAccount === 1,
          currentTask: (devInfo as any).currentTask || '离线/空闲',
          currentAccount: (devInfo as any).currentAccount || '未登录',
          runningTime: (devInfo as any).runningTime || 0,
          licenseBound: regCode.code,
          heartbeatsCount: isOnline ? connection?.pingCount || 0 : 0,
          connectedAt:
            isOnline && connection?.connectedAt
              ? connection.connectedAt.toISOString()
              : null,
          lastError: lastErrorLog
            ? {
                message: lastErrorLog.message,
                timestamp: lastErrorLog.timestamp.toISOString(),
              }
            : null,
        };
      }),
    );

    return list;
  }

  /**
   * 获取卡密警报配置
   */
  async getAlertConfig(code: string) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
      select: {
        alertEmail: true,
        alertConfig: true,
      },
    });

    if (!regCode) {
      throw new NotFoundException('注册激活码不存在');
    }

    return {
      alertEmail: regCode.alertEmail || '',
      alertConfig: regCode.alertConfig || {
        offline: true,
        offlineTimeout: 10,
        launcher: true,
        locked: false,
        vpn: true,
        errorLog: true,
        memoryLimit: 153600,
      },
    };
  }

  /**
   * 更新卡密警报配置
   */
  async updateAlertConfig(code: string, alertEmail: string, alertConfig: any) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    if (!regCode) {
      throw new NotFoundException('注册激活码不存在');
    }

    await this.prisma.registerCode.update({
      where: { code },
      data: {
        alertEmail: alertEmail || null,
        alertConfig: alertConfig || undefined,
      },
    });

    await this.recordActionLog(
      code,
      'UPDATE_ALERT',
      `更新了邮箱报警推送配置: 邮箱 ${alertEmail || '未设置'}`,
      'user',
    );

    return { success: true, message: '警报配置更新成功' };
  }

  /**
   * 获取最近紧急警报历史列表
   */
  getAlertHistory() {
    return this.tcpSocketService.getAlertHistory();
  }

  /**
   * 获取当前激活码的基础状态 (供用户端拉取)
   */
  async getCodeStatus(code: string) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    if (!regCode) {
      throw new NotFoundException('注册激活码不存在');
    }

    return {
      code: regCode.code,
      expireTime: regCode.expireTime,
      maxActive: regCode.maxActive,
      isEnabled: regCode.status !== 0,
    };
  }

  /**
   * 导入老系统激活码表格数据并实现覆盖式更新(Upsert)
   */
  async importBoundCodes(
    fileBuffer: Buffer,
    options: {
      appId?: string;
      allowedFeatures?: string[];
      maxActivations?: number;
      statusMode?: 'file' | 'active' | 'disabled';
    },
  ) {
    const { appId, allowedFeatures: customFeatures, maxActivations, statusMode = 'file' } = options;
    let boundApp: any = null;
    if (appId) {
      boundApp = await this.prisma.app.findUnique({
        where: { id: appId },
        include: { features: true },
      });
    }

    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    // 转化为二维数组，每个单元格为原始数据
    const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1 });

    if (rows.length <= 2) {
      throw new BadRequestException('导入的 Excel 数据行为空，请检查文件！');
    }

    // 第二行（索引为 1）应当是表头，校验核心字段
    const headers = rows[1];
    const codeIdx = headers.indexOf('注册码');
    const typeIdx = headers.indexOf('注册码类型');
    const appIdx = headers.indexOf('应用名称');
    const statusIdx = headers.indexOf('注册码状态');
    const activeTimeIdx = headers.indexOf('激活时间');
    const expireTimeIdx = headers.indexOf('到期时间');
    const orderIdx = headers.indexOf('注册码订单号');
    const verIdx = headers.indexOf('版本类型');

    if (codeIdx === -1 || typeIdx === -1 || statusIdx === -1) {
      throw new BadRequestException(
        'Excel 格式错误，缺失“注册码”、“注册码类型”或“注册码状态”列！',
      );
    }

    const importedCodes = [];

    // 从第三行（索引为 2）开始读取实际数据
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length === 0) continue;

      const rawCode = row[codeIdx]?.toString().trim();
      if (!rawCode || rawCode.length < 6) continue; // 过滤无意义的空行或无效注册码

      const rawType = row[typeIdx]?.toString().trim();
      const rawAppName = appIdx !== -1 ? row[appIdx]?.toString().trim() : null;
      const rawStatus = row[statusIdx]?.toString().trim();
      const rawActiveTime = activeTimeIdx !== -1 ? row[activeTimeIdx] : null;
      const rawExpireTime = expireTimeIdx !== -1 ? row[expireTimeIdx] : null;
      const rawOrder = orderIdx !== -1 ? row[orderIdx]?.toString().trim() : '';
      const rawVer = verIdx !== -1 ? row[verIdx]?.toString().trim() : '';

      // 字段规则映射
      let appName =
        rawAppName === '通用型版本' || !rawAppName ? null : rawAppName;

      let boundAppId: string | null = null;
      let allowedFeatures: string[] = [];

      if (boundApp) {
        boundAppId = boundApp.id;
        appName = boundApp.name;
        allowedFeatures = customFeatures || boundApp.features?.map((f: any) => f.code) || [];
      }

      let cardType = 'YK';
      let durationMinutes = 43200;

      if (rawType === '周卡') {
        cardType = 'WK';
        durationMinutes = 10080;
      } else if (rawType === '月卡') {
        cardType = 'YK';
        durationMinutes = 43200;
      } else if (rawType === '年卡') {
        cardType = 'NK';
        durationMinutes = 525600;
      } else if (rawType === '永久' || rawType === '永久卡') {
        cardType = 'YJ';
        durationMinutes = 52560000;
      }

      let status = 1;
      if (rawStatus === '已停用' || rawStatus === '已禁用') {
        status = 0;
      } else if (rawStatus === '已激活') {
        status = 2;
      } else if (rawStatus === '已到期') {
        status = 3;
      }

      // 根据状态控制选项做覆写
      if (statusMode === 'active') {
        status = 2;
      } else if (statusMode === 'disabled') {
        status = 0;
      }

      const activatedAt = rawActiveTime ? new Date(rawActiveTime) : null;
      const expireTime = rawExpireTime ? new Date(rawExpireTime) : null;

      let remark = '老系统导入';
      if (rawVer) remark += ` | 版本: ${rawVer}`;
      if (rawOrder) remark += ` | 订单号: ${rawOrder}`;

      const maxActive = maxActivations && maxActivations > 0 ? maxActivations : 1;

      importedCodes.push({
        code: rawCode,
        appName,
        appId: boundAppId,
        cardType,
        durationMinutes,
        status,
        activatedAt,
        expireTime,
        remark,
        maxActive,
        usedNum: 0,
        bindDevices: '[]',
        allowedApis: JSON.stringify(['api:data:fetch', 'script:run']),
        allowedFeatures,
        source: 'IMPORT',
      });
    }

    if (importedCodes.length === 0) {
      return {
        success: true,
        message: '未在大表里检索到任何合规的数据！',
        count: 0,
      };
    }

    const allImportedCodes = importedCodes.map((item) => item.code);

    // 1. 批量查找数据库中已存在的记录
    const existingRecords = await this.prisma.registerCode.findMany({
      where: {
        code: { in: allImportedCodes },
      },
      select: {
        code: true,
      },
    });

    const existingCodesSet = new Set(existingRecords.map((r) => r.code));

    const toCreate = [];
    const toUpdate = [];

    for (const item of importedCodes) {
      if (existingCodesSet.has(item.code)) {
        toUpdate.push(item);
      } else {
        toCreate.push(item);
      }
    }

    let createdCount = 0;
    let updatedCount = 0;

    // 2. 新记录：批量一次性插入
    if (toCreate.length > 0) {
      const createRes = await this.prisma.registerCode.createMany({
        data: toCreate,
      });
      createdCount = createRes.count;
    }

    // 3. 冲突记录：大批量事务覆盖更新
    if (toUpdate.length > 0) {
      await this.prisma.$transaction(
        toUpdate.map((item) =>
          this.prisma.registerCode.update({
            where: { code: item.code },
            data: {
              appId: item.appId,
              allowedFeatures: item.allowedFeatures as Prisma.InputJsonValue,
              maxActive: item.maxActive,
              appName: item.appName,
              cardType: item.cardType,
              durationMinutes: item.durationMinutes,
              status: item.status,
              activatedAt: item.activatedAt,
              expireTime: item.expireTime,
              remark: `${item.remark} [覆盖导入]`,
              source: 'IMPORT',
            },
          }),
        ),
      );
      updatedCount = toUpdate.length;
    }

    if (toCreate.length > 0) {
      await Promise.all(
        toCreate.map((item) =>
          this.recordActionLog(item.code, 'GENERATE', '老系统 Excel 导入新建'),
        ),
      );
    }
    if (toUpdate.length > 0) {
      await Promise.all(
        toUpdate.map((item) =>
          this.recordActionLog(
            item.code,
            'ADJUST',
            '老系统 Excel 导入并覆盖同步',
          ),
        ),
      );
    }

    return {
      success: true,
      message: `老系统激活码导入完成！成功创建 ${createdCount} 条，覆盖更新 ${updatedCount} 条。`,
      createdCount,
      updatedCount,
    };
  }

  /**
   * 记录卡密操作变更日志
   */
  async recordActionLog(
    code: string,
    actionType: string,
    description: string,
    operator: string = 'admin',
  ) {
    try {
      await this.prisma.registerCodeLog.create({
        data: {
          code,
          actionType,
          description,
          operator,
        },
      });
    } catch (e) {
      console.error('Failed to write register code action log:', e);
    }
  }

  /**
   * 分页查询卡密操作变更日志
   */
  async findActionLogs(
    page: number,
    limit: number,
    options?: { code?: string; actionType?: string },
  ) {
    const skip = (page - 1) * limit;
    const where: any = {};
    if (options?.code) {
      where.code = { contains: options.code, mode: 'insensitive' };
    }
    if (options?.actionType) {
      where.actionType = options.actionType;
    }
    const [list, total] = await Promise.all([
      this.prisma.registerCodeLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.registerCodeLog.count({ where }),
    ]);
    return {
      list: list.map((item: any) => ({
        id: item.id,
        code: item.code,
        actionType: item.actionType,
        description: item.description,
        operator: item.operator,
        createdAt: item.createdAt.toISOString(),
      })),
      total,
    };
  }

  /**
   * 批量更新激活码启用状态
   */
  async batchUpdateStatus(ids: string[], status: 'active' | 'disabled') {
    if (!ids || ids.length === 0) {
      throw new BadRequestException('请选择至少一个激活码！');
    }

    const records = await this.prisma.registerCode.findMany({
      where: { id: { in: ids } },
    });

    if (records.length === 0) {
      throw new NotFoundException('未找到任何合规的激活码！');
    }

    const action = status === 'disabled' ? 'DISABLE' : 'ENABLE';
    const actionDesc =
      status === 'disabled' ? '批量禁用注册码' : '批量启用注册码';

    const updates = records.map((record) => {
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
        where: { id: record.id },
        data: { status: numericStatus },
      });
    });

    await this.prisma.$transaction(updates);

    // 记录审计日志
    await Promise.all(
      records.map((record) =>
        this.recordActionLog(record.code, action, actionDesc),
      ),
    );

    return { success: true, count: records.length };
  }

  /**
   * 批量微调激活码剩余有效时长
   */
  async batchAdjustDuration(ids: string[], minutes: number, reason: string) {
    if (!ids || ids.length === 0) {
      throw new BadRequestException('请选择至少一个激活码！');
    }

    const records = await this.prisma.registerCode.findMany({
      where: { id: { in: ids } },
    });

    // 过滤掉永久卡 (YJ)
    const validRecords = records.filter((r) => r.cardType !== 'YJ');

    if (validRecords.length === 0) {
      return {
        success: true,
        count: 0,
        message: '选择的激活码中没有可调整时间的非永久卡。',
      };
    }

    const nowStr = new Date().toLocaleDateString('zh-CN');
    const adjustmentLog = `[${nowStr}] 批量调整 ${minutes > 0 ? '+' : ''}${minutes}分钟 (原因: ${reason || '无'})`;

    const updates = validRecords.map((record) => {
      let updateData: Prisma.RegisterCodeUpdateInput = {};
      const newRemark = record.remark
        ? `${record.remark} | ${adjustmentLog}`
        : adjustmentLog;

      if (!record.activatedAt) {
        // 尚未激活，直接调整初始可用时长
        const nextDuration = Math.max(1, record.durationMinutes + minutes);
        updateData = {
          durationMinutes: nextDuration,
          remark: newRemark,
        };
      } else {
        // 已激活，加减截止时间 expireTime
        const currentExpireTime = record.expireTime
          ? new Date(record.expireTime)
          : new Date();
        const nextExpireTime = new Date(
          currentExpireTime.getTime() + minutes * 60 * 1000,
        );

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
        where: { id: record.id },
        data: updateData,
      });
    });

    await this.prisma.$transaction(updates);

    // 记录审计日志
    await Promise.all(
      validRecords.map((record) =>
        this.recordActionLog(
          record.code,
          'ADJUST',
          `批量微调时长 ${minutes > 0 ? '+' : ''}${minutes}分钟。原因: ${reason || '无'}`,
        ),
      ),
    );

    return { success: true, count: validRecords.length };
  }

  /**
   * 批量物理注销作废激活码
   */
  async batchDelete(ids: string[]) {
    if (!ids || ids.length === 0) {
      throw new BadRequestException('请选择至少一个激活码！');
    }

    const records = await this.prisma.registerCode.findMany({
      where: { id: { in: ids } },
    });

    if (records.length === 0) {
      return { success: true, count: 0 };
    }

    // 收集所有需要踢线的设备ID
    const deviceIdsToKick = new Set<string>();
    for (const record of records) {
      let devices = [];
      try {
        devices =
          typeof record.bindDevices === 'string'
            ? JSON.parse(record.bindDevices)
            : (record.bindDevices as any[]) || [];
      } catch (e) {
        devices = [];
      }
      for (const dev of devices) {
        if (dev.deviceId) {
          deviceIdsToKick.add(dev.deviceId);
        }
      }
    }

    // 强制踢线
    for (const devId of deviceIdsToKick) {
      this.tcpSocketService.forceKickDevice(devId);
    }

    // 事务删除关联表与主表
    await this.prisma.$transaction([
      this.prisma.registerCodeDevice.deleteMany({
        where: { registerCodeId: { in: ids } },
      }),
      this.prisma.registerCode.deleteMany({
        where: { id: { in: ids } },
      }),
    ]);

    // 记录审计日志
    await Promise.all(
      records.map((record) =>
        this.recordActionLog(record.code, 'DELETE', '批量物理注销作废该卡密'),
      ),
    );

    return { success: true, count: records.length };
  }

  /**
   * 业务脚本专用的 HTTP 设备绑定与鉴权校验接口服务
   */
  async verifyCode(code: string, deviceId: string) {
    if (!code || !deviceId) {
      return { success: false, message: '注册码和设备ID不能为空' };
    }

    // 前置拉黑拦截
    const isBlacklisted = await this.prisma.registerCodeBlacklist.findFirst({
      where: {
        registerCode: { code },
        deviceId,
      },
    });
    if (isBlacklisted) {
      return { success: false, message: '该设备已被禁止绑定此授权码' };
    }

    // 1. 查找注册码
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
      include: { boundDevices: true },
    });

    if (!regCode) {
      return { success: false, message: '该注册码不存在' };
    }

    if (regCode.status === 0) {
      return { success: false, message: '该注册码已被管理员禁用' };
    }

    const now = new Date();

    // 2. 检查是否已过期
    if (regCode.expireTime && now > new Date(regCode.expireTime)) {
      if (regCode.status !== 3) {
        await this.prisma.registerCode.update({
          where: { id: regCode.id },
          data: { status: 3 },
        });
      }
      return { success: false, message: '该注册码已过期失效' };
    }

    // 3. 检查当前设备是否已经绑定过该卡密
    const isAlreadyBound = regCode.boundDevices.some(
      (d) => d.deviceId === deviceId,
    );
    if (isAlreadyBound) {
      return {
        success: true,
        message: '设备验证成功',
        expireTime: regCode.expireTime
          ? regCode.expireTime.toISOString()
          : null,
      };
    }

    // 4. 新设备尝试绑定，检查额度
    if (regCode.usedNum >= regCode.maxActive) {
      return {
        success: false,
        message: `绑定设备数已达上限 (${regCode.maxActive}台)，请在控制台解绑旧设备`,
      };
    }

    // 5. 进行激活逻辑计算 (如果是首次激活)
    let updatedExpireTime = regCode.expireTime;
    let updatedActivatedAt = regCode.activatedAt;

    if (!regCode.activatedAt) {
      updatedActivatedAt = now;
      if (regCode.cardType === 'YJ') {
        updatedExpireTime = new Date(
          now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000,
        ); // 100 年
      } else {
        updatedExpireTime = new Date(
          now.getTime() + regCode.durationMinutes * 60 * 1000,
        );
      }
    }

    // 处理旧的 bindDevices Json 列，兼容后台显示
    let devicesList: BindDeviceItem[] = [];
    try {
      devicesList =
        typeof regCode.bindDevices === 'string'
          ? JSON.parse(regCode.bindDevices)
          : (regCode.bindDevices as unknown as BindDeviceItem[]) || [];
    } catch (e) {
      devicesList = [];
    }

    if (!devicesList.some((d) => d.deviceId === deviceId)) {
      devicesList.push({
        deviceId,
        activatedAt: now.toISOString(),
        lastActiveAt: now.toISOString(),
      });
    }

    const nextUsedNum = regCode.usedNum + 1;
    const nextStatus = nextUsedNum >= regCode.maxActive ? 4 : 2; // 4 为已满，2 为使用中

    // 6. 开启 Prisma 数据库事务
    await this.prisma.$transaction(async (tx) => {
      // 写入物理关联表
      await tx.registerCodeDevice.create({
        data: {
          registerCodeId: regCode.id,
          deviceId,
        },
      });

      // 更新卡密主表信息 (包括旧 of bindDevices 字段以维持兼容性)
      await tx.registerCode.update({
        where: { id: regCode.id },
        data: {
          activatedAt: updatedActivatedAt,
          expireTime: updatedExpireTime,
          usedNum: nextUsedNum,
          status: nextStatus,
          bindDevices: devicesList as unknown as Prisma.InputJsonValue,
        },
      });
    });

    // 写入操作审计日志
    await this.recordActionLog(
      regCode.code,
      'ADJUST',
      `设备 [${deviceId}] 进行了绑定认证 (当前绑定数: ${nextUsedNum}/${regCode.maxActive})`,
    );

    return {
      success: true,
      message: '新设备绑定并验证成功',
      expireTime: updatedExpireTime ? updatedExpireTime.toISOString() : null,
    };
  }

  /**
   * 强制切换设备的登录账号 (Web 大屏下发)
   */
  async switchAccountDevice(
    code: string,
    deviceId: string,
    operator: string = 'user',
    reason?: string,
  ) {
    let regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    if (!regCode && code) {
      const cleanCode = code.trim().toUpperCase();
      regCode = await this.prisma.registerCode.findUnique({
        where: { code: cleanCode },
      });
    }

    if (!regCode) {
      throw new NotFoundException('该注册码不存在！');
    }

    const isOnline = this.tcpSocketService.isDeviceOnline(deviceId);
    if (!isOnline) {
      throw new BadRequestException('该设备当前不在线，无法下发换号指令！');
    }

    const activeMsg = reason || '用户在网页端手动执行强制换号';
    this.tcpSocketService.forceSwitchAccountDevice(deviceId, activeMsg);

    await this.recordActionLog(
      regCode.code,
      'SWITCH_ACCOUNT',
      `设备 [${deviceId}] 被执行强制换号指令: ${activeMsg}`,
      operator,
    );

    return { success: true, message: '强制换号指令已成功下发至客户端！' };
  }

  /**
   * 主动查询账号是否已被其他设备登录 (查重)
   */
  async checkAccountStatus(code: string, deviceId: string, account: string) {
    let regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    if (!regCode && code) {
      const cleanCode = code.trim().toUpperCase();
      regCode = await this.prisma.registerCode.findUnique({
        where: { code: cleanCode },
      });
    }

    if (!regCode) {
      throw new NotFoundException('该注册码不存在！');
    }

    const config = (regCode.alertConfig as Record<string, any>) || {};
    const preventDuplicate = config.preventDuplicateAccount === true;

    if (!preventDuplicate) {
      return { success: true, isOccupied: false };
    }

    const onlineDevices = this.tcpSocketService.getOnlineDevicesByCode(
      regCode.code,
    );
    let isOccupied = false;

    for (const devId of onlineDevices) {
      if (devId !== deviceId) {
        const conn = this.tcpSocketService.getActiveConnection(devId);
        if (conn && conn.deviceInfo?.currentAccount === account.trim()) {
          const lastActive = conn.lastActiveTime;
          const now = new Date();
          const timeoutMs = 3 * 60 * 1000;
          if (lastActive && now.getTime() - lastActive.getTime() > timeoutMs) {
            try {
              this.tcpSocketService.forceKickDevice(devId);
            } catch (kickErr) {}
            continue;
          }
          isOccupied = true;
          break;
        }
      }
    }

    return { success: true, isOccupied };
  }

  /**
   * 解绑单个绑定的物理设备
   */
  async unbindSingleDevice(
    code: string,
    deviceId: string,
    operator: string = 'user',
  ) {
    console.log(
      '[DEBUG Unbind] input code:',
      JSON.stringify(code),
      'deviceId:',
      deviceId,
      'operator:',
      operator,
    );

    // 1. 尝试直接查询
    let regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    // 2. 防御性二次查询（消除空格与大小写影响）
    if (!regCode && code) {
      const cleanCode = code.trim().toUpperCase();
      if (cleanCode !== code) {
        regCode = await this.prisma.registerCode.findUnique({
          where: { code: cleanCode },
        });
      }
    }

    if (!regCode) {
      throw new NotFoundException('该注册码不存在！');
    }

    const activeRegCode = regCode;

    let devices: BindDeviceItem[] = [];
    try {
      devices =
        typeof activeRegCode.bindDevices === 'string'
          ? JSON.parse(activeRegCode.bindDevices)
          : (activeRegCode.bindDevices as unknown as BindDeviceItem[]) || [];
    } catch (e) {
      devices = [];
    }

    const devIndex = devices.findIndex((d) => d.deviceId === deviceId);
    if (devIndex === -1) {
      throw new BadRequestException('该设备未绑定至此注册码！');
    }

    const targetDev = devices[devIndex];
    devices.splice(devIndex, 1);

    const boundAt = targetDev.activatedAt
      ? new Date(targetDev.activatedAt)
      : new Date();
    const lastIp = targetDev.ip || '127.0.0.1';
    const deviceName = targetDev.name || `设备 (${deviceId.slice(0, 8)})`;

    const updatedUsedNum = devices.length;
    let nextStatus = activeRegCode.status;
    if (
      activeRegCode.expireTime &&
      new Date() > new Date(activeRegCode.expireTime)
    ) {
      nextStatus = 3;
    } else if (activeRegCode.status !== 0) {
      nextStatus = updatedUsedNum >= activeRegCode.maxActive ? 4 : 2;
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. 删除物理绑定表关联
      await tx.registerCodeDevice.deleteMany({
        where: {
          registerCodeId: activeRegCode.id,
          deviceId,
        },
      });

      // 2. 插入解绑历史记录
      await tx.registerCodeUnbindHistory.create({
        data: {
          registerCodeId: activeRegCode.id,
          deviceId,
          deviceName,
          boundAt,
          unbindAt: new Date(),
          lastIp,
          unbindReason: operator,
        },
      });

      // 3. 更新主表状态
      await tx.registerCode.update({
        where: { id: activeRegCode.id },
        data: {
          bindDevices: devices as unknown as Prisma.InputJsonValue,
          usedNum: updatedUsedNum,
          status: nextStatus,
        },
      });
    });

    // 4. 通知 Kick 掉物理长连接设备
    this.tcpSocketService.forceKickDevice(deviceId);

    await this.recordActionLog(
      activeRegCode.code,
      'UNBIND',
      `设备物理解绑。设备ID: [${deviceId}]`,
      operator,
    );

    return { success: true };
  }

  /**
   * 将设备加入卡密黑名单
   */
  async addDeviceToBlacklist(
    code: string,
    deviceId: string,
    deviceName?: string,
    reason?: string,
    operator: string = 'user',
  ) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    if (!regCode) {
      throw new NotFoundException('该注册码不存在！');
    }

    let finalDeviceName = deviceName;
    let devices: BindDeviceItem[] = [];
    try {
      devices =
        typeof regCode.bindDevices === 'string'
          ? JSON.parse(regCode.bindDevices)
          : (regCode.bindDevices as unknown as BindDeviceItem[]) || [];
    } catch (e) {
      devices = [];
    }

    const boundDev = devices.find((d) => d.deviceId === deviceId);
    if (boundDev && !finalDeviceName) {
      finalDeviceName = boundDev.name || `设备 (${deviceId.slice(0, 8)})`;
    }

    await this.prisma.registerCodeBlacklist.upsert({
      where: {
        registerCodeId_deviceId: {
          registerCodeId: regCode.id,
          deviceId,
        },
      },
      create: {
        registerCodeId: regCode.id,
        deviceId,
        deviceName: finalDeviceName || `设备 (${deviceId.slice(0, 8)})`,
        reason,
      },
      update: {
        deviceName: finalDeviceName || undefined,
        reason,
        blockedAt: new Date(),
      },
    });

    // 若当前设备绑定于此激活码，强制解绑
    const isBound = devices.some((d) => d.deviceId === deviceId);
    if (isBound) {
      await this.unbindSingleDevice(code, deviceId, operator);
    } else {
      this.tcpSocketService.forceKickDevice(deviceId);
    }

    await this.recordActionLog(
      regCode.code,
      'BLACKLIST_ADD',
      `拉黑绑定设备 [${deviceId}]。原因: ${reason || '无'}`,
      operator,
    );

    return { success: true };
  }

  /**
   * 解除设备黑名单
   */
  async removeDeviceFromBlacklist(
    code: string,
    deviceId: string,
    operator: string = 'user',
  ) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    if (!regCode) {
      throw new NotFoundException('该注册码不存在！');
    }

    await this.prisma.registerCodeBlacklist.deleteMany({
      where: {
        registerCodeId: regCode.id,
        deviceId,
      },
    });

    await this.recordActionLog(
      regCode.code,
      'BLACKLIST_REMOVE',
      `将设备 [${deviceId}] 移出黑名单`,
      operator,
    );

    return { success: true };
  }

  /**
   * 查询黑名单列表
   */
  async getBlacklist(code: string) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });
    if (!regCode) {
      throw new NotFoundException('该注册码不存在！');
    }
    return this.prisma.registerCodeBlacklist.findMany({
      where: { registerCodeId: regCode.id },
      orderBy: { blockedAt: 'desc' },
    });
  }

  /**
   * 查询解绑历史记录
   */
  async getUnbindHistory(code: string) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });
    if (!regCode) {
      throw new NotFoundException('该注册码不存在！');
    }
    return this.prisma.registerCodeUnbindHistory.findMany({
      where: { registerCodeId: regCode.id },
      orderBy: { unbindAt: 'desc' },
    });
  }

  /**
   * 获取指定设备在 2 天之内的账号登录运行历史记录 (鉴权验证)
   */
  async getDeviceAccountHistory(code: string, deviceId: string) {
    // 1. 安全校验：确认该 deviceId 是否绑定在此 code 下 (或者曾经被绑定过)
    const isBound = await this.prisma.registerCode.findFirst({
      where: {
        code,
        boundDevices: {
          some: {
            deviceId,
          },
        },
      },
    });

    if (!isBound) {
      // 检查解绑历史，防备刚刚解绑的设备想要查询
      const hasHistory = await this.prisma.registerCodeUnbindHistory.findFirst({
        where: {
          registerCode: { code },
          deviceId,
        },
      });
      if (!hasHistory) {
        throw new BadRequestException('无权访问该设备的账号历史记录');
      }
    }

    // 2. 查询 2 天内的账号变更记录 (48小时)
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    return this.prisma.deviceAccountHistory.findMany({
      where: {
        deviceId,
        code,
        createdAt: {
          gte: twoDaysAgo,
        },
      },
      orderBy: {
        loginTime: 'desc',
      },
    });
  }
}
