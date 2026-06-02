import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import Redis from 'ioredis'; // 模拟 Redis 连接

@Injectable()
export class QpsRateLimiter implements NestInterceptor {
  private redisClient: Redis;

  constructor() {
    this.redisClient = new Redis(); // 建立高速物理缓存信道
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    
    // 提取请求参数中绑定的激活码 (LicenseCode) 或设备唯一 MAC/IP
    const licenseCode = request.headers['x-license-code'] || request.query.code;
    
    if (!licenseCode) {
      throw new HttpException('未检测到合法授权激活码！', HttpStatus.FORBIDDEN);
    }

    // 1. 从缓存/数据库中读取该激活码的最大允许限制 (默认限制为 5 QPS)
    const maxQpsLimit = await this.getLicenseQpsLimit(licenseCode);

    // 2. 利用 Redis 实现高并发滑动窗口 / 令牌桶算法
    const currentSecondKey = `ratelimit:${licenseCode}:${Math.floor(Date.now() / 1000)}`;
    
    // 执行原子自增，并设定 2 秒物理自动失效，规避内存积压
    const requestCount = await this.redisClient.incr(currentSecondKey);
    if (requestCount === 1) {
      await this.redisClient.expire(currentSecondKey, 2);
    }

    // 3. 超过设定的 QPS 限制，直接安全熔断，返回 429 Too Many Requests
    if (requestCount > maxQpsLimit) {
      throw new HttpException(
        {
          success: false,
          code: HttpStatus.TOO_MANY_REQUESTS,
          message: `请求过度频繁！该授权码当前限制为 ${maxQpsLimit} QPS，请减缓端侧发送速率。`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return next.handle();
  }

  private async getLicenseQpsLimit(code: string): Promise<number> {
    const cacheKey = `license:qps:${code}`;
    const cachedLimit = await this.redisClient.get(cacheKey);
    if (cachedLimit) {
      return parseInt(cachedLimit, 10);
    }

    // 模拟如果 Redis 穿透，则去 PostgreSQL 查询
    const dbLimit = 5; 
    await this.redisClient.set(cacheKey, dbLimit.toString(), 'EX', 600); // 缓存 10 分钟
    return dbLimit;
  }
}
