import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 动态加载数据库 SMTP 设置并发射邮件验证码。
   * 若功能关闭或发送失败，退回控制台日志输出。
   */
  async sendVerificationCode(email: string, code: string): Promise<boolean> {
    // 1. 查询数据库 SMTP 设置
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
          ],
        },
      },
    });

    const config: Record<string, string> = {};
    settings.forEach((item) => {
      config[item.key] = item.value;
    });

    const mailEnabled = config['mail_enabled'] === 'true';
    const smtpHost = config['smtp_host'];
    const smtpPort = config['smtp_port'];
    const smtpUser = config['smtp_user'];
    const smtpPass = config['smtp_pass'];
    const smtpFrom = config['smtp_from'] || smtpUser;

    // 2. 如果邮件功能关闭或配置不全，退回控制台输出以方便开发调试
    if (!mailEnabled || !smtpHost || !smtpPort || !smtpUser || !smtpPass) {
      this.logger.warn(
        `[邮件服务未启用/配置缺失] 本地测试模式验证码如下:\n` +
          `-----------------------------------------\n` +
          `[验证码] 邮箱: ${email} | 验证码: ${code}\n` +
          `-----------------------------------------`,
      );
      return false;
    }

    // 3. 构建 SMTP 传输客户端并发送
    try {
      const port = parseInt(smtpPort, 10) || 465;
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port,
        secure: port === 465, // 465 为 SSL 连接
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      await transporter.sendMail({
        from: smtpFrom,
        to: email,
        subject: '【小宝修仙】管理员密码重置安全验证码',
        html: `
          <div style="padding: 24px; font-family: sans-serif; background-color: #f8fafc; color: #1e293b; border-radius: 8px;">
            <h2 style="color: #059669; font-weight: bold; margin-bottom: 16px;">小宝修仙</h2>
            <p style="font-size: 14px; line-height: 1.5;">您正在尝试修改小宝修仙后台管理员账号密码，安全验证码如下：</p>
            <div style="font-size: 32px; font-weight: 800; letter-spacing: 4px; color: #059669; margin: 24px 0; padding: 12px; background: #ecfdf5; border-radius: 6px; text-align: center;">
              ${code}
            </div>
            <p style="font-size: 12px; color: #64748b; margin-top: 24px;">验证码有效期为 10 分钟。如果非您本人的操作，请忽略此邮件。</p>
          </div>
        `,
      });

      this.logger.log(`[SMTP] 邮件验证码已投递至: ${email}`);
      return true;
    } catch (err) {
      this.logger.error(`[SMTP] 邮件发送异常，降级输出至控制台`, err);
      this.logger.warn(
        `[开发测试模式兜底] 验证码如下:\n` +
          `-----------------------------------------\n` +
          `[验证码] 邮箱: ${email} | 验证码: ${code}\n` +
          `-----------------------------------------`,
      );
      return false;
    }
  }
}
