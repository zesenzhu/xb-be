/**
 * @file: auth.controller.ts
 * @description: 认证控制层。暴露管理员账号密码登录与用户大屏激活码无密码登录两套物理接口。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { Controller, Post, Body, Req, Res, HttpStatus, HttpCode, UnauthorizedException } from '@nestjs/common';
import * as express from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { UserLicenseLoginDto } from './dto/user-license-login.dto';

@ApiTags('Auth 身份认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * 1. 管理员端登录接口
   * @param body AdminLoginDto
   * @param res Express 响应实例
   */
  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '管理员登录',
    description: '使用管理员账号和密码进行鉴权，成功后会将 access_token 和 refresh_token 写入管理员端的 HttpOnly Cookie。',
  })
  @ApiResponse({ status: 200, description: '登录成功' })
  @ApiResponse({ status: 401, description: '账号不存在或密码错误' })
  async adminLogin(
    @Body() body: AdminLoginDto,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const user = await this.authService.validateAdmin(body.username, body.password);
    
    // 动态映射角色标识，防止前端 role.code 识别崩溃
    const roleCode = user.role.name === '超级管理员' ? 'admin' : 'operator';

    // 签发 Token
    const tokens = await this.authService.generateTokens({
      sub: user.id,
      username: user.username,
      role: roleCode,
    });

    // 写入 Cookie
    this.authService.setCookies(res, tokens, 'admin');

    return {
      success: true,
      message: '管理员登录成功',
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname || user.username,
        role: {
          id: user.role.id,
          name: user.role.name,
          code: roleCode,
        },
      },
      permissions: user.role.permissions.map(p => p.code),
    };
  }

  /**
   * 2. 用户大屏端激活码登录接口 (无密码，直接绑定设备)
   * @param body UserLicenseLoginDto
   * @param req Express 请求实例
   * @param res Express 响应实例
   */
  @Post('user/license-login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '用户端激活码登录',
    description: '使用生成的授权激活码登录并自动物理绑定当前设备，成功后会将 user_access_token 写入用户端的 HttpOnly Cookie。无需密码。',
  })
  @ApiResponse({ status: 200, description: '设备验证并激活登录成功' })
  @ApiResponse({ status: 400, description: '激活码失效或设备数已满' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async userLicenseLogin(
    @Body() body: UserLicenseLoginDto,
    @Req() req: express.Request,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    // 自动指纹指派：如果前端没提供 deviceId，则从请求头或 IP/UA 中提取，甚至如果都拿不到，AuthService 会自动生成 UUID 并返回
    const clientIp = req.ip || req.headers['x-forwarded-for'] as string || '127.0.0.1';
    const userAgent = req.headers['user-agent'] || 'unknown';

    const { regCode, deviceId } = await this.authService.validateLicense(
      body.code,
      body.deviceId,
      clientIp,
      userAgent,
    );

    // 签发 Token (子账号设为 license id，角色设定为 client 终端)
    const tokens = await this.authService.generateTokens({
      sub: regCode.id,
      username: regCode.code,
      role: 'client',
    });

    // 写入独立的 user Cookie，绝不与管理员 Token 冲突
    this.authService.setCookies(res, tokens, 'user');

    // 解析 allowedApis JSON
    let parsedPermissions: string[] = [];
    try {
      parsedPermissions = typeof regCode.allowedApis === 'string'
        ? JSON.parse(regCode.allowedApis)
        : (regCode.allowedApis as string[]) || [];
    } catch (e) {
      parsedPermissions = [];
    }

    return {
      success: true,
      message: '授权激活码登录成功，设备绑定已激活',
      user: {
        id: `lic-${regCode.id}`,
        username: regCode.code,
        nickname: `授权终端 (${regCode.code.slice(0, 7)})`,
        email: 'client@xbnest.com',
        role: {
          id: 'role-client-uuid',
          name: '终端授权用户',
          code: 'client',
        },
        deviceId: deviceId, // 回传给前端
      },
      permissions: parsedPermissions,
    };
  }

  /**
   * 3. 管理员端 Token 续期接口
   * @param req Request
   * @param res Response
   */
  @Post('admin/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '管理员 Token 静默刷新',
    description: '通过读取 HttpOnly Cookie 中的 refresh_token 进行静默无感续签 access_token。',
  })
  async adminRefresh(
    @Req() req: express.Request,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const refreshToken = req.cookies?.['refresh_token'];
    if (!refreshToken) {
      throw new UnauthorizedException('无权刷新 Token，请重新登录');
    }

    const payload = await this.authService.verifyRefreshToken(refreshToken);
    const tokens = await this.authService.generateTokens({
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
    });

    this.authService.setCookies(res, tokens, 'admin');

    return { success: true, message: '管理员令牌续期成功' };
  }

  /**
   * 4. 用户端 Token 续期接口
   * @param req Request
   * @param res Response
   */
  @Post('user/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '用户端 Token 静默刷新',
    description: '通过读取 HttpOnly Cookie 中的 user_refresh_token 进行静默无感续签 user_access_token。',
  })
  async userRefresh(
    @Req() req: express.Request,
    @Res({ passthrough: true }) res: express.Response,
  ) {
    const refreshToken = req.cookies?.['user_refresh_token'];
    if (!refreshToken) {
      throw new UnauthorizedException('无权刷新 Token，请重新登录');
    }

    const payload = await this.authService.verifyRefreshToken(refreshToken);
    const tokens = await this.authService.generateTokens({
      sub: payload.sub,
      username: payload.username,
      role: payload.role,
    });

    this.authService.setCookies(res, tokens, 'user');

    return { success: true, message: '用户令牌续期成功' };
  }

  /**
   * 5. 管理员端退出登录
   * @param res Response
   */
  @Post('admin/logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '管理员注销登出',
    description: '安全清理管理员端 Cookie 凭证。',
  })
  async adminLogout(@Res({ passthrough: true }) res: express.Response) {
    this.authService.clearCookies(res, 'admin');
    return { success: true, message: '已安全登出管理员控制台' };
  }

  /**
   * 6. 用户端退出登录
   * @param res Response
   */
  @Post('user/logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '用户端注销登出',
    description: '安全清理用户端 Cookie 凭证。',
  })
  async userLogout(@Res({ passthrough: true }) res: express.Response) {
    this.authService.clearCookies(res, 'user');
    return { success: true, message: '已安全断开设备连接' };
  }
}

