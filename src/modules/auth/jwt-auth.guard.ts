import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
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
      throw new UnauthorizedException('未登录或认证凭证已过期');
    }

    try {
      const payload = await this.jwtService.verifyAsync<{ role: string; sub: string; username: string }>(token, {
        secret: process.env.JWT_SECRET || 'xb-secret-key-2026',
      });
      
      // 将解析出的 payload 挂载到 request.user 上
      (request as any).user = payload;
      return true;
    } catch (e) {
      throw new UnauthorizedException('认证令牌无效或已失效，请重新登录');
    }
  }
}
