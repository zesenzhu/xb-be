/**
 * @file: script-log.controller.ts
 * @description: 运行日志控制器。提供网页端 SSE 实时推送与 PostgreSQL 历史日志查询 API。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import {
  Controller,
  Get,
  Sse,
  MessageEvent,
  Query,
  HttpStatus,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { TcpSocketService } from '../tcp-socket/tcp-socket.service';
import { Prisma } from '@prisma/client';
import { Observable, merge, interval } from 'rxjs';
import { filter, map, finalize } from 'rxjs/operators';

@ApiTags('ScriptLog 日志管理')
@Controller('logs')
export class ScriptLogController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tcpSocketService: TcpSocketService,
  ) {}

  /**
   * 1. 网页端实时订阅日志流 (SSE 通道)
   */
  @Sse('stream')
  @ApiOperation({
    summary: '实时日志推送流 (SSE)',
    description: '网页端订阅特定设备实时日志。连入触发上报，断连释放。',
  })
  streamLogs(
    @Query('deviceId') deviceId: string,
    @Query('code') code: string,
  ): Observable<MessageEvent> {
    if (!deviceId) {
      throw new BadRequestException('参数 deviceId 不能为空');
    }

    // 网页端开始收听，增加计数并下发指令给 TCP 设备开启日志上报
    this.tcpSocketService.addViewer(deviceId);

    return this.tcpSocketService.logBroadcaster$.pipe(
      // 过滤：仅输出此设备的日志且和对应的注册码匹配
      filter((event) => event.deviceId === deviceId),
      map(
        (event) =>
          ({
            data: event.log,
          }) as MessageEvent,
      ),
      // 断开连接时自动清理：通知设备停止上报
      finalize(() => {
        this.tcpSocketService.removeViewer(deviceId);
      }),
    );
  }

  /**
   * 1.5 用户端全局统一多路混合 SSE 长连接通道
   */
  @Sse('user-stream')
  @ApiOperation({
    summary: '用户端全局混合长连接通道 (SSE)',
    description: '网页端订阅此注册码关联的所有物理设备的实时日志、上线/下线列表更新、设备状态电量变动以及全局心跳包。',
  })
  userStreamLogs(
    @Query('code') code: string,
  ): Observable<MessageEvent> {
    if (!code) {
      throw new BadRequestException('参数 code (授权码) 不能为空');
    }

    // 注册网页客户端监视器（开启当前所有在线设备的日志传输）
    this.tcpSocketService.addWebClient(code);

    // 1. 日志事件流订阅，过滤并打包为 log 类别
    const logsStream$ = this.tcpSocketService.logBroadcaster$.pipe(
      filter((event) => event.code === code),
      map((event) => ({
        data: {
          type: 'log',
          payload: {
            deviceId: event.deviceId,
            ...event.log,
          },
        },
      }))
    );

    // 2. 设备上下线与状态电量变动事件订阅
    const deviceStateStream$ = this.tcpSocketService.deviceState$.pipe(
      filter((event) => event.code === code),
      map((event) => ({
        data: {
          type: event.type, // 'device_list' | 'device_status'
          payload: event.payload,
        },
      }))
    );

    // 3. 全局统一心跳定时任务 (10秒一次) 用于维持连线并让前端知道链路活跃
    const heartbeatStream$ = interval(10000).pipe(
      map(() => ({
        data: {
          type: 'heartbeat',
          payload: {
            timestamp: Date.now(),
          },
        },
      }))
    );

    // 4. 合并三路数据流输出，并在关闭时自动卸载，断开所属设备的日志推送以省电
    return merge(logsStream$, deviceStateStream$, heartbeatStream$).pipe(
      finalize(() => {
        this.tcpSocketService.removeWebClient(code);
      })
    );
  }

  /**
   * 2. 查询历史日志 (数据库分页)
   */
  @Get('history')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '查询历史日志列表',
    description: '支持按设备ID、注册码ID、日志级别进行分页查询。',
  })
  async getHistory(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('deviceId') deviceId?: string,
    @Query('registerCodeId') registerCodeId?: string,
    @Query('level') level?: string,
  ) {
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const limitNum = limit ? Math.max(1, parseInt(limit, 10)) : 20;
    const skip = (pageNum - 1) * limitNum;

    const where: Prisma.ScriptLogWhereInput = {};
    if (deviceId) {
      where.deviceId = deviceId;
    }
    if (registerCodeId) {
      where.registerCodeId = registerCodeId;
    }
    if (level && level !== 'ALL') {
      where.level = level;
    }

    const [list, total] = await Promise.all([
      this.prisma.scriptLog.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { timestamp: 'desc' },
      }),
      this.prisma.scriptLog.count({ where }),
    ]);

    // 对齐前端展示模型
    const formattedList = list.map((item) => {
      // 兼容历史老数据或日志前缀解析模块名
      let moduleName = 'EXECUTOR';
      let cleanContent = item.message;
      const match = item.message.match(/^\[(.*?)\] (.*)$/);
      if (match) {
        moduleName = match[1];
        cleanContent = match[2];
      }

      return {
        id: item.id,
        time: item.timestamp.toTimeString().split(' ')[0],
        level: item.level,
        module: moduleName,
        content: cleanContent,
      };
    });

    return { list: formattedList, total };
  }
}
