/**
 * @file: tcp-simulator.controller.ts
 * @description: 物理 TCP 长连接模拟器控制器。允许网页管理员在后台通过发送 HTTP 请求，
 *               在 NestJS 后端进程内代为创建一个真实的 TCP Socket 客户端去连接 8082 端口，
 *               从而完美模拟按键精灵客户端与后端的 TCP 物理交互、心跳及日志上报。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  BadRequestException,
  OnModuleDestroy,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import * as net from 'net';

// =========================================================================
// 1. DTO 传输协议定义
// =========================================================================

export class TcpSimConnectDto {
  @IsString()
  @IsNotEmpty({ message: '注册码不能为空' })
  code: string;

  @IsString()
  @IsNotEmpty({ message: '模拟设备ID不能为空' })
  deviceId: string;

  @IsString()
  @IsOptional()
  appName?: string;
}

export class LogItemDto {
  @IsString()
  @IsOptional()
  time?: string;

  @IsString()
  @IsNotEmpty({ message: '日志级别不能为空' })
  level: string;

  @IsString()
  @IsNotEmpty({ message: '日志模块不能为空' })
  module: string;

  @IsString()
  @IsNotEmpty({ message: '日志内容不能为空' })
  content: string;

  @IsString()
  @IsOptional()
  timestamp?: string;
}

export class TcpSimLogDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LogItemDto)
  logs: LogItemDto[];
}

export class TcpSimDisconnectDto {
  @IsString()
  @IsNotEmpty()
  deviceId: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => LogItemDto)
  logs?: LogItemDto[];
}

// 终端监控记录接口
interface TerminalLine {
  direction: 'send' | 'receive' | 'system';
  timestamp: string;
  payload: string;
}

interface SimulatorSession {
  socket: net.Socket;
  history: TerminalLine[];
}

@ApiTags('TCP 长连接物理模拟器')
@Controller('tcp-simulator')
export class TcpSimulatorController implements OnModuleDestroy {
  // 维护多物理长连接模拟会话的进程内 Map
  private readonly sessions = new Map<string, SimulatorSession>();

  onModuleDestroy() {
    // 模块销毁时，强制关闭所有活动的模拟 Socket，防止句柄泄露
    for (const [deviceId, session] of this.sessions.entries()) {
      session.socket.destroy();
    }
    this.sessions.clear();
  }

  /**
   * 往终端记录中追加日志帧回显
   */
  private appendHistory(
    deviceId: string,
    direction: 'send' | 'receive' | 'system',
    payload: string,
  ) {
    const session = this.sessions.get(deviceId);
    if (!session) return;

    const now = new Date().toTimeString().split(' ')[0];
    session.history.push({
      direction,
      timestamp: now,
      payload,
    });

    // 限制最近 100 行回显
    if (session.history.length > 100) {
      session.history.shift();
    }
  }

  @Post('connect')
  @ApiOperation({
    summary: '与 8082 端口建立物理 TCP 长连接，并触发 auth 鉴权握手',
  })
  async connect(@Body() body: TcpSimConnectDto) {
    const { code, deviceId, appName = 'XB-SimulatorClient' } = body;

    // 1. 如果已存在，先强制销毁旧连接
    if (this.sessions.has(deviceId)) {
      const oldSession = this.sessions.get(deviceId)!;
      oldSession.socket.destroy();
      this.sessions.delete(deviceId);
    }

    return new Promise((resolve, reject) => {
      // 2. 建立本地 TCP 连接连接到 TcpSocketService 端口 (8082)
      const socket = net.createConnection(
        { port: 8082, host: '127.0.0.1' },
        () => {
          // TCP 握手物理成功
          const session: SimulatorSession = {
            socket,
            history: [],
          };
          this.sessions.set(deviceId, session);
          this.appendHistory(
            deviceId,
            'system',
            `物理 TCP 握手成功，成功连接至 127.0.0.1:8082`,
          );

          // 3. 立即下发鉴权帧 (必须带上换行符 \n 突破黏包解析)
          const authPayload = JSON.stringify({
            action: 'auth',
            code,
            deviceId,
            appName,
          });

          socket.write(authPayload + '\n');
          this.appendHistory(deviceId, 'send', authPayload);
        },
      );

      let responseHandled = false;
      let buffer = '';

      socket.on('data', (data) => {
        const rawStr = data.toString('utf8');
        buffer += rawStr;

        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          const frame = buffer.substring(0, newlineIdx).trim();
          buffer = buffer.substring(newlineIdx + 1);

          if (frame) {
            this.appendHistory(deviceId, 'receive', frame);

            // 如果是鉴权后的首帧响应，解析并返回给 HTTP 路由
            if (!responseHandled) {
              responseHandled = true;
              try {
                const parsed = JSON.parse(frame);
                if (parsed.status === 'ok') {
                  resolve({
                    status: 'success',
                    message: '模拟客户端 TCP 握手及授权激活成功！',
                    terminalEcho: frame,
                  });
                } else {
                  reject(
                    new BadRequestException(
                      `鉴权授权失败: ${parsed.message || '未知原因'}`,
                    ),
                  );
                }
              } catch (e) {
                reject(new BadRequestException(`无法解析鉴权响应包: ${frame}`));
              }
            }
          }
          newlineIdx = buffer.indexOf('\n');
        }
      });

      socket.on('error', (err) => {
        if (!responseHandled) {
          responseHandled = true;
          reject(
            new BadRequestException(
              `模拟 TCP 物理连接建立异常: ${err.message}`,
            ),
          );
        } else {
          this.appendHistory(deviceId, 'system', `Socket 异常: ${err.message}`);
        }
      });

      socket.on('close', () => {
        this.appendHistory(deviceId, 'system', `物理 TCP 长连接通道已断开。`);
        this.sessions.delete(deviceId);
      });

      // 5秒 超时兜底，防止 Promise 悬挂
      setTimeout(() => {
        if (!responseHandled) {
          responseHandled = true;
          socket.destroy();
          this.sessions.delete(deviceId);
          reject(
            new BadRequestException('连接 TCP 8082 服务端鉴权超时（5秒）'),
          );
        }
      }, 5000);
    });
  }

  @Post('ping')
  @ApiOperation({ summary: '发送心跳 ping 包指令' })
  async ping(@Body() body: { deviceId: string }) {
    const { deviceId } = body;
    const session = this.sessions.get(deviceId);
    if (!session) {
      throw new BadRequestException('该设备 TCP 模拟长连接未开启，请先连接');
    }

    const pingPayload = JSON.stringify({
      action: 'ping',
      deviceId,
    });

    session.socket.write(pingPayload + '\n');
    this.appendHistory(deviceId, 'send', pingPayload);

    return { status: 'success', message: '心跳数据包发送成功' };
  }

  @Post('log')
  @ApiOperation({ summary: '发送实时日志 log_chunk 包' })
  async sendLog(@Body() body: TcpSimLogDto) {
    const { deviceId, logs } = body;
    const session = this.sessions.get(deviceId);
    if (!session) {
      throw new BadRequestException('该设备 TCP 模拟长连接未开启，请先连接');
    }

    const logPayload = JSON.stringify({
      action: 'log_chunk',
      deviceId,
      logs: logs.map((l) => ({
        time: l.time || new Date().toTimeString().split(' ')[0],
        level: l.level,
        module: l.module,
        content: l.content,
      })),
    });

    session.socket.write(logPayload + '\n');
    this.appendHistory(deviceId, 'send', logPayload);

    return { status: 'success', message: '实时日志数据包推送成功' };
  }

  @Post('disconnect')
  @ApiOperation({ summary: '发送 exit_log 并主动断开 TCP 长连接' })
  async disconnect(@Body() body: TcpSimDisconnectDto) {
    const { deviceId, logs = [] } = body;
    const session = this.sessions.get(deviceId);
    if (!session) {
      return { status: 'success', message: '连接已处于断开状态' };
    }

    // 1. 如果传入了退出归档日志，先发送 exit_log 归档帧
    if (logs.length > 0) {
      const exitPayload = JSON.stringify({
        action: 'exit_log',
        deviceId,
        logs: logs.map((l) => ({
          level: l.level,
          module: l.module,
          content: l.content,
          timestamp: l.timestamp || new Date().toISOString(),
        })),
      });
      session.socket.write(exitPayload + '\n');
      this.appendHistory(deviceId, 'send', exitPayload);

      // 稍微延迟 200ms 以确保数据完全写出到 TCP 物理通道中，然后再关闭 socket
      await new Promise((r) => setTimeout(r, 200));
    }

    // 2. 关闭连接
    session.socket.end();
    this.sessions.delete(deviceId);

    return { status: 'success', message: '模拟客户端 TCP 物理连接已断开归档' };
  }

  @Get('terminal')
  @ApiOperation({ summary: '获取当前设备的 TTY 终端报文传输日志' })
  getTerminalHistory(@Query('deviceId') deviceId: string) {
    const session = this.sessions.get(deviceId);
    if (!session) {
      return {
        online: false,
        history: [
          {
            direction: 'system',
            timestamp: new Date().toTimeString().split(' ')[0],
            payload: '设备当前离线，没有活动的 TCP 连接。',
          },
        ],
      };
    }

    return {
      online: true,
      history: session.history,
    };
  }
}
