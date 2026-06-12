import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SystemSettingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 获取所有系统设置并格式化为 K-V 字典。
   * 安全规则：若存在 smtp_pass，返回 ****** 实施遮蔽。
   */
  async getSettings() {
    const list = await this.prisma.systemSetting.findMany();
    const settings: Record<string, string> = {};
    list.forEach((item) => {
      if (item.key === 'smtp_pass' && item.value) {
        settings[item.key] = '******';
      } else {
        settings[item.key] = item.value;
      }
    });

    // 默认键兜底
    const defaultKeys = [
      'mail_enabled',
      'smtp_host',
      'smtp_port',
      'smtp_user',
      'smtp_pass',
      'smtp_from',
    ];
    defaultKeys.forEach((key) => {
      if (settings[key] === undefined) {
        settings[key] = key === 'mail_enabled' ? 'false' : '';
      }
    });

    return settings;
  }

  /**
   * 批量保存或更新系统配置
   */
  async saveSettings(settings: Record<string, string>) {
    for (const [key, val] of Object.entries(settings)) {
      // 过滤安全遮蔽：如果是 smtp_pass 且为 ******，跳过覆盖
      if (key === 'smtp_pass' && val === '******') {
        continue;
      }

      await this.prisma.systemSetting.upsert({
        where: { key },
        update: { value: val.trim() },
        create: { key, value: val.trim() },
      });
    }
    return { success: true, message: '系统设置保存成功' };
  }

  /**
   * 获取公开属性：是否开启邮件验证码
   */
  async getPublicSettings() {
    const setting = await this.prisma.systemSetting.findUnique({
      where: { key: 'mail_enabled' },
    });
    return {
      emailEnabled: setting?.value === 'true',
    };
  }
}
