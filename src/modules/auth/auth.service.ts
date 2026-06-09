/**
 * @file: auth.service.ts
 * @description: 鉴权与物理连接模块服务层。实现管理员端与用户激活码端物理登录、双通道 Cookie 签发、以及 JWT 无感续期。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { Injectable, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { PrismaService } from '../prisma/prisma.service';
import { Response } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class AuthService {
  // 定义本地开发默认 JWT 秘钥
  private readonly jwtSecret = process.env.JWT_SECRET || 'xb-secret-key-2026';

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 1. 验证管理员账号密码
   * 
   * @param username 用户名
   * @param pass 明文密码
   */
  async validateAdmin(username: string, pass: string) {
    const user = await this.userService.findByUsername(username);
    if (!user) {
      throw new UnauthorizedException('该管理员账户不存在');
    }

    const isMatch = await this.userService.comparePassword(pass, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('管理员登录密码错误');
    }

    // 物理拦截：管理员端必须确保角色不是 client (终端授权用户)
    if (user.role.name === '终端授权用户') {
      throw new UnauthorizedException('无权使用该通道登录管理控制台');
    }

    return user;
  }

  /**
   * 2. 验证用户端注册激活码 (无密码，直接设备绑定登录)
   * 
   * @param code 注册激活码
   * @param clientDeviceId 客户端传入的设备 ID (可选)
   * @param ip 客户端 IP 地址
   * @param userAgent 客户端浏览器 User-Agent
   */
  async validateLicense(code: string, clientDeviceId?: string, ip?: string, userAgent?: string) {
    // 1. 查询激活码
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code },
    });

    if (!regCode) {
      throw new NotFoundException('激活码不存在，请输入正确的注册码');
    }

    // 2. 校检状态与有效期
    if (regCode.status === 0) {
      throw new BadRequestException('该激活码已被后台禁用，请联系管理员');
    }

    const now = new Date();
    
    // 首次激活初始化时间
    let updatedActivatedAt = regCode.activatedAt;
    let updatedExpireTime = regCode.expireTime;
    let nextStatus = regCode.status;
    let needUpdate = false;
    
    if (!regCode.activatedAt) {
      updatedActivatedAt = now;
      if (regCode.cardType === 'YJ') {
        updatedExpireTime = new Date(now.getTime() + 100 * 365 * 24 * 60 * 60 * 1000);
      } else {
        updatedExpireTime = new Date(now.getTime() + regCode.durationMinutes * 60 * 1000);
      }
      nextStatus = 2; // 首次激活置为使用中 (2)
      needUpdate = true;
    }

    if (updatedExpireTime && now > updatedExpireTime) {
      if (regCode.status !== 3) {
        await this.prisma.registerCode.update({
          where: { id: regCode.id },
          data: { status: 3 },
        });
      }
      throw new BadRequestException('该激活码已过期失效');
    }

    // 回写首次激活的数据，但不记录设备绑定
    if (needUpdate) {
      await this.prisma.registerCode.update({
        where: { id: regCode.id },
        data: {
          activatedAt: updatedActivatedAt,
          expireTime: updatedExpireTime,
          status: nextStatus,
        },
      });
    }

    // 大屏用户端登录，分配一个虚拟 web 终端 ID，但绝不写入 bindDevices (不占绑定上限名额)
    const finalDeviceId = clientDeviceId ? clientDeviceId.trim() : 'web-client';

    return {
      regCode: {
        ...regCode,
        activatedAt: updatedActivatedAt,
        expireTime: updatedExpireTime,
        status: nextStatus,
      },
      deviceId: finalDeviceId,
    };
  }

  /**
   * 3. 物理签发 JWT 双 Token (AccessToken 与 RefreshToken)
   * 
   * @param payload JWT 载荷信息
   */
  async generateTokens(payload: { sub: string; username: string; role: string }) {
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.jwtSecret,
      expiresIn: '1h', // 访问令牌 1 小时失效
    });

    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.jwtSecret,
      expiresIn: '7d', // 刷新令牌 7 天失效
    });

    return { accessToken, refreshToken };
  }

  /**
   * 4. 写入安全跨域 HTTP Cookie
   * 
   * @param res Express 响应实例
   * @param tokens JWT 双令牌
   * @param type 登录物理通道类型 (admin 或 user)
   */
  setCookies(res: Response, tokens: { accessToken: string; refreshToken: string }, type: 'admin' | 'user') {
    const isProduction = process.env.NODE_ENV === 'production';
    
    // 物理防冲突：管理员与普通用户使用不同名称的 Cookie
    const accessCookieName = type === 'admin' ? 'access_token' : 'user_access_token';
    const refreshCookieName = type === 'admin' ? 'refresh_token' : 'user_refresh_token';

    // 写入访问令牌：1 小时有效期
    res.cookie(accessCookieName, tokens.accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 1000,
    });

    // 写入刷新令牌：7 天有效期
    res.cookie(refreshCookieName, tokens.refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  /**
   * 5. 清理物理跨域 Cookie (注销/退登)
   * 
   * @param res Express 响应实例
   * @param type 物理通道类型
   */
  clearCookies(res: Response, type: 'admin' | 'user') {
    const isProduction = process.env.NODE_ENV === 'production';
    const accessCookieName = type === 'admin' ? 'access_token' : 'user_access_token';
    const refreshCookieName = type === 'admin' ? 'refresh_token' : 'user_refresh_token';

    res.clearCookie(accessCookieName, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
    });
    res.clearCookie(refreshCookieName, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax',
      path: '/',
    });
  }

  /**
   * 6. 无感续期 Refresh Token
   * 
   * @param token 客户端传入的刷新令牌
   */
  async verifyRefreshToken(token: string) {
    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: this.jwtSecret,
      });
      return payload;
    } catch (e) {
      throw new UnauthorizedException('刷新令牌无效或已过期，请重新登录');
    }
  }
}
