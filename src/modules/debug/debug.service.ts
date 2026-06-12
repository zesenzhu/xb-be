import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DebugService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 1. 快速创建用于测试的临时卡密 (以 XB-DEBUG- 开头)
   */
  async createTempCode() {
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const testCode = `XB-DEBUG-${randomSuffix}`;
    
    const record = await this.prisma.registerCode.create({
      data: {
        code: testCode,
        cardType: 'YK',
        durationMinutes: 43200, // 30天
        maxActive: 1,
        status: 1, // 正常可用
        bindDevices: '[]',
        allowedApis: '[]'
      }
    });

    return {
      success: true,
      message: `临时测试卡密 ${testCode} 创建成功！`,
      data: record
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
}
