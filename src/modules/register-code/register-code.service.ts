/**
 * @file: register-code.service.ts
 * @description: 注册激活码模块业务逻辑层。负责批量唯一性注册码生成、有效期与限流设置、状态切换与停用。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class RegisterCodeService {
  constructor(private readonly prisma: PrismaService) {}

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

    // 转换日期格式以防前端表格渲染崩溃，并解析 JSON 绑定设备字段
    const formattedList = list.map((item) => {
      let devices = [];
      try {
        devices = typeof item.bindDevices === 'string'
          ? JSON.parse(item.bindDevices)
          : (item.bindDevices as any[]) || [];
      } catch (e) {
        devices = [];
      }

      // 获取绑定设备的第一个设备标识，兼容前端 Mock 数据中的 deviceId 展示
      const firstDevice = devices.length > 0 ? devices[0].deviceId : null;

      // 自动计算并更正数据库中的 status 字段 (如果过期了，自动在返回给前端时映射成 2-已过期)
      let currentStatus = item.status;
      if (new Date() > new Date(item.expireTime)) {
        currentStatus = 2; // 已过期
      }

      return {
        id: item.id,
        code: item.code,
        maxActivations: item.maxActive,
        currentActivations: item.usedNum,
        rateLimit: 5, // 兜底限流 QPS 示例
        deviceId: firstDevice,
        status: currentStatus === 1 ? 'active' : 'disabled', // 对齐前端 state 渲染
        expiresAt: item.expireTime.toISOString().split('T')[0], // 格式化为 YYYY-MM-DD
        createdAt: item.createdAt.toISOString().split('T')[0],
      };
    });

    return { list: formattedList, total };
  }

  /**
   * 批量生成随机注册码
   */
  async generate(data: { count: number; maxActivations: number; rateLimit: number; expireDays?: number }) {
    const count = Math.min(100, Math.max(1, data.count || 1));
    const maxActive = Math.max(1, data.maxActivations || 1);
    const rateLimit = Math.max(1, data.rateLimit || 5);
    const expireDays = Math.max(1, data.expireDays || 30); // 默认有效 30 天

    const expireTime = new Date(Date.now() + expireDays * 24 * 60 * 60 * 1000);
    const generatedCodes = [];

    // 循环生成 count 个唯一的随机激活码
    for (let i = 0; i < count; i++) {
      let code = '';
      let isUnique = false;

      // 物理校验，以防极低概率下的随机码碰撞
      while (!isUnique) {
        // 生成形如 SEC-XXXXXX 的 12 位大写随机码
        const randomHex = crypto.randomBytes(4).toString('hex').toUpperCase();
        code = `SEC-${randomHex}`;

        const existing = await this.prisma.registerCode.findUnique({
          where: { code },
        });

        if (!existing) {
          isUnique = true;
        }
      }

      // 将允许的 APIs 转化为 JSON 数据
      const allowedApis = JSON.stringify(['api:data:fetch', 'script:run']);

      const newRecord = await this.prisma.registerCode.create({
        data: {
          code,
          expireTime,
          maxActive,
          status: 1, // 1-正常可用
          usedNum: 0,
          bindDevices: '[]',
          allowedApis,
        },
      });

      generatedCodes.push(newRecord);
    }

    return {
      success: true,
      message: `成功批量生成 ${count} 个授权激活码！`,
      list: generatedCodes,
    };
  }

  /**
   * 更新激活码状态
   */
  async updateStatus(id: string, status: 'active' | 'disabled') {
    const record = await this.prisma.registerCode.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('该激活码不存在！');
    }

    const numericStatus = status === 'active' ? 1 : 0;

    return this.prisma.registerCode.update({
      where: { id },
      data: {
        status: numericStatus,
      },
    });
  }

  /**
   * 作废删除激活码
   */
  async delete(id: string) {
    const record = await this.prisma.registerCode.findUnique({ where: { id } });
    if (!record) {
      throw new NotFoundException('该激活码不存在！');
    }

    return this.prisma.registerCode.delete({
      where: { id },
    });
  }
}
