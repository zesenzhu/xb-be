import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    
    // 优先从 cookies 读取，其次从 headers 的 bearer token 读取
    let token = request.cookies?.['access_token'] as string | undefined;
    
    if (!token) {
      const authHeader = request.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      throw new UnauthorizedException('未提供认证凭证');
    }

    try {
      const payload = await this.jwtService.verifyAsync<{ role: string; sub: string; username: string }>(token, {
        secret: process.env.JWT_SECRET || 'xb-secret-key-2026',
      });
      
      // 必须是超级管理员角色 (admin)
      if (payload.role !== 'admin') {
        throw new ForbiddenException('仅限超级管理员访问此调试接口');
      }
      
      // 将用户信息挂载到 request 上，方便后续控制器使用
      (request as any).user = payload;
      return true;
    } catch (e) {
      if (e instanceof ForbiddenException) {
        throw e;
      }
      throw new UnauthorizedException('认证令牌无效或已过期');
    }
  }
}
