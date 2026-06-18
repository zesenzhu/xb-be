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
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TcpSocketService } from '../tcp-socket/tcp-socket.service';
import { Observable, merge, interval } from 'rxjs';
import { filter, map, finalize } from 'rxjs/operators';
import { AdminGuard } from '../debug/admin.guard';

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
    description:
      '网页端订阅此注册码关联的所有物理设备的实时日志、上线/下线列表更新、设备状态电量变动以及全局心跳包。',
  })
  userStreamLogs(@Query('code') code: string): Observable<MessageEvent> {
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
      })),
    );

    // 2. 设备上下线与状态电量变动事件订阅
    const deviceStateStream$ = this.tcpSocketService.deviceState$.pipe(
      filter((event) => event.code === code),
      map((event) => ({
        data: {
          type: event.type, // 'device_list' | 'device_status'
          payload: event.payload,
        },
      })),
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
      })),
    );

    // 4. 合并三路数据流输出，并在关闭时自动卸载，断开所属设备的日志推送以省电
    return merge(logsStream$, deviceStateStream$, heartbeatStream$).pipe(
      finalize(() => {
        this.tcpSocketService.removeWebClient(code);
      }),
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
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 💡 1. 针对单个设备进行分级裁剪与混合拉取（INFO 100条 + ERROR 24小时）
    if (deviceId) {
      // 1.1 获取该设备最新的 100 条 INFO 日志
      const infoQuery = this.prisma.scriptLog.findMany({
        where: {
          deviceId,
          level: 'INFO',
          ...(registerCodeId ? { registerCodeId } : {}),
        },
        orderBy: { timestamp: 'desc' },
        take: 100,
      });

      // 1.2 获取该设备最近 24 小时内最新的 100 条 WARN/ERROR 日志，防止历史旧报错淹没控制台
      const errQuery = this.prisma.scriptLog.findMany({
        where: {
          deviceId,
          level: { in: ['WARN', 'ERROR'] },
          timestamp: { gte: oneDayAgo },
          ...(registerCodeId ? { registerCodeId } : {}),
        },
        orderBy: { timestamp: 'desc' },
        take: 100,
      });

      const [infoLogs, errLogs] = await Promise.all([infoQuery, errQuery]);

      // 1.3 在内存中合并并按 ID 去重
      const allLogs = [...infoLogs, ...errLogs];
      const uniqueLogs = Array.from(
        new Map(allLogs.map((item) => [item.id, item])).values(),
      );

      // 按时间戳从最新到最老倒序排列
      uniqueLogs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

      // 1.4 对齐前端展示模型
      const formattedList = uniqueLogs.map((item) => {
        let moduleName = 'EXECUTOR';
        let cleanContent = item.message;
        const match = item.message.match(/^\[(.*?)\] (.*)$/);
        if (match) {
          moduleName = match[1];
          cleanContent = match[2];
        }

        return {
          id: item.id,
          time: item.timestamp.toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false,
          }),
          level: item.level,
          module: moduleName,
          content: cleanContent,
        };
      });

      return { list: formattedList, total: formattedList.length };
    }

    // 💡 2. 兜底：全局日志审计，退回 24 小时内普通分页查询
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const limitNum = limit ? Math.max(1, parseInt(limit, 10)) : 20;
    const skip = (pageNum - 1) * limitNum;

    const where: Prisma.ScriptLogWhereInput = {
      timestamp: { gte: oneDayAgo }, // 强制限制 24 小时内
    };
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
      let moduleName = 'EXECUTOR';
      let cleanContent = item.message;
      const match = item.message.match(/^\[(.*?)\] (.*)$/);
      if (match) {
        moduleName = match[1];
        cleanContent = match[2];
      }

      return {
        id: item.id,
        time: item.timestamp.toLocaleTimeString('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour12: false,
        }),
        level: item.level,
        module: moduleName,
        content: cleanContent,
      };
    });

    return { list: formattedList, total };
  }

  @Get('export')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '管理员导出指定设备24小时分级日志' })
  async exportDeviceLogs(@Query('deviceId') deviceId: string, @Res() res: any) {
    if (!deviceId) {
      throw new BadRequestException('参数 deviceId 不能为空');
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="device-${deviceId}-24h.log"`,
    );

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // 1. 获取该设备最新的 100 条 INFO 日志
    const infoLogs = await this.prisma.scriptLog.findMany({
      where: { deviceId, level: 'INFO' },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    // 2. 获取该设备最近 24 小时内所有的 WARN/ERROR 日志
    const errLogs = await this.prisma.scriptLog.findMany({
      where: {
        deviceId,
        level: { in: ['WARN', 'ERROR'] },
        timestamp: { gte: oneDayAgo },
      },
      orderBy: { timestamp: 'desc' },
    });

    // 3. 在内存中合并并按 ID 去重
    const allLogs = [...infoLogs, ...errLogs];
    const uniqueLogs = Array.from(
      new Map(allLogs.map((item) => [item.id, item])).values(),
    );

    // 正序排列
    uniqueLogs.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    // 4. 流式写入 Response
    for (const log of uniqueLogs) {
      const formattedLine = `[${log.timestamp.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}] [${log.level}] ${log.message}\n`;
      res.write(formattedLine);
    }

    res.end();
  }
}
