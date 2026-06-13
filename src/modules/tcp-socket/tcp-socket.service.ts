/**
 * @file: tcp-socket.service.ts
 * @description: 原生 TCP Socket 服务端实现。用于与按键精灵客户端建立持久 TCP 握手，处理登录激活、心跳机制、实时指令下发以及智能日志上报。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import { Injectable, OnApplicationBootstrap, OnApplicationShutdown, Logger, Inject, forwardRef } from '@nestjs/common';
import { RegisterCodeService } from '../register-code/register-code.service';
import { PrismaService } from '../prisma/prisma.service';
import * as net from 'net';
import { Subject } from 'rxjs';

interface ClientConnection {
  socket: net.Socket;
  code: string;
  codeId: string;
  deviceId: string;
  appName?: string;
  pingCount?: number;
  deviceInfo?: {
    name: string;
    model: string;
    os: string;
    osVersion: string;
    resolution: string;
    dpi: number;
    isRoot: number;
    battery: number;
    ip: string;
    diskSpace?: string;
    cpuTemp?: number;
    cpuLoad?: number;
    rtt?: number;
  };
}


@Injectable()
export class TcpSocketService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TcpSocketService.name);
  private server: net.Server;
  private readonly port = 8082;

  // 内存中维护所有活跃的 TCP 长连接: deviceId -> ConnectionInfo
  private readonly activeConnections = new Map<string, ClientConnection>();

  // 记录各设备当前网页端实时日志订阅人数: deviceId -> count
  private readonly logStreamViewers = new Map<string, number>();

  // 记录当前活跃在网页端的全局监视授权码
  private readonly activeWebClients = new Set<string>();

  // 全局的日志流广播 Subject，用于桥接 TCP 上报与 SSE 推送
  public readonly logBroadcaster$ = new Subject<{
    deviceId: string;
    code: string;
    log: {
      id: string;
      time: string;
      level: 'INFO' | 'WARN' | 'ERROR';
      module: string;
      content: string;
    };
  }>();

  // 全局的设备状态广播 Subject，用于推送设备上线、下线、电量变化等事件到网页端
  public readonly deviceState$ = new Subject<{
    type: 'device_list' | 'device_status';
    code: string;
    deviceId: string;
    payload: any;
  }>();

  constructor(
    @Inject(forwardRef(() => RegisterCodeService))
    private readonly registerCodeService: RegisterCodeService,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap() {
    this.startServer();
  }

  onApplicationShutdown() {
    this.stopServer();
  }

  /**
   * 启动 TCP 服务端
   */
  private startServer() {
    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      this.logger.log(`TCP Socket 运行服务器启动成功，正在监听端口: ${this.port}`);
    });

    this.server.on('error', (err) => {
      this.logger.error(`TCP Socket 运行服务器发生致命错误:`, err.stack);
    });
  }

  /**
   * 停止 TCP 服务端并关闭所有活动长连接
   */
  private stopServer() {
    this.logger.log('正在关闭 TCP Socket 服务端...');
    for (const [deviceId, conn] of this.activeConnections.entries()) {
      conn.socket.end();
      this.logger.log(`已主动断开设备连接: ${deviceId}`);
    }
    this.activeConnections.clear();

    if (this.server) {
      this.server.close(() => {
        this.logger.log('TCP Socket 服务端已安全退出');
      });
    }
  }

  /**
   * 处理单个客户端 TCP 物理连接
   */
  private handleConnection(socket: net.Socket) {
    // 设置超时机制以防恶意占用通道 (默认为 90秒 心跳超时)
    socket.setTimeout(90000);
    
    let deviceId: string | null = null;
    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString('utf8');
      
      // 按照换行符 \n 切割消息帧以防粘包
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.substring(0, newlineIdx).trim();
        buffer = buffer.substring(newlineIdx + 1);
        
        if (line) {
          try {
            await this.processMessage(socket, line, (id) => {
              deviceId = id;
            });
          } catch (err) {
            this.logger.error(`解析数据帧出错: ${line}`, err);
            socket.write(JSON.stringify({ status: 'error', message: 'Bad request frame format' }) + '\n');
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });

    // 超时断开逻辑 (心跳断流)
    socket.on('timeout', () => {
      this.logger.warn(`客户端长连接超时无心跳响应，将被强制回收: ${deviceId || '未知设备'}`);
      socket.end();
    });

    socket.on('close', () => {
      if (deviceId) {
        this.logger.log(`客户端连接已断开，清理缓存: ${deviceId}`);
        const conn = this.activeConnections.get(deviceId);
        if (conn) {
          // 广播设备下线事件
          this.deviceState$.next({
            type: 'device_list',
            code: conn.code,
            deviceId,
            payload: {
              action: 'offline',
              deviceId,
            }
          });
        }
        this.activeConnections.delete(deviceId);
        this.logStreamViewers.delete(deviceId);
      }
    });

    socket.on('error', (err) => {
      this.logger.error(`客户端连接发生异常: ${deviceId || '未知设备'}`, err.message);
    });
  }

  /**
   * 解析并处理单条 JSON 协议指令数据
   */
  private async processMessage(socket: net.Socket, rawMessage: string, setDeviceId: (id: string) => void) {
    interface MessageData {
      action?: string;
      code?: string;
      deviceId?: string;
      appName?: string;
      deviceInfo?: ClientConnection['deviceInfo'];
      battery?: number;
      cpuTemp?: number;
      cpuLoad?: number;
      rtt?: number;
      logs?: Array<{
        level: 'INFO' | 'WARN' | 'ERROR';
        module: string;
        content: string;
        time: string;
        timestamp: number;
      }>;
    }
    const data = JSON.parse(rawMessage) as MessageData;
    const action = data.action || '';
    const code = data.code || '';
    const deviceId = data.deviceId || '';
    const appName = data.appName || '';
    const deviceInfo = data.deviceInfo;

    if (!action) {
      socket.write(JSON.stringify({ status: 'error', message: 'Missing action field' }) + '\n');
      return;
    }

    // 1. 鉴权激活握手
    if (action === 'auth') {
      if (!code || !deviceId) {
        socket.write(JSON.stringify({ status: 'error', message: 'Auth action requires code and deviceId' }) + '\n');
        return;
      }

      try {
        // 调用注册码服务尝试登录激活
        const authResult = await this.registerCodeService.activateCode(code, deviceId, appName, deviceInfo);
        
        // 绑定设备标识至本地 socket 钩子
        setDeviceId(deviceId);

        // 注册到在线长连接内存映射中
        this.activeConnections.set(deviceId, {
          socket,
          code,
          codeId: authResult.codeId,
          deviceId,
          appName,
          pingCount: 0,
          deviceInfo,
        });

        // 广播设备上线/列表更新事件
        this.deviceState$.next({
          type: 'device_list',
          code,
          deviceId,
          payload: {
            action: 'online',
            deviceId,
            appName,
            deviceInfo,
            ip: this.getDeviceRemoteIp(deviceId),
          }
        });

        this.logger.log(`客户端设备通过 TCP 鉴权成功: [${deviceId}] 注册码 [${code}]`);
        
        // 响应客户端
        socket.write(JSON.stringify({
          status: 'ok',
          message: 'Authentication successful',
          data: {
            expireTime: authResult.expireTime,
            maxActive: authResult.maxActive,
            usedNum: authResult.usedNum,
          }
        }) + '\n');

        // 💡 顺便检查一下：如果刚刚在没有连接前，已经有网页端正在监视（管理员或授权码用户），我们立刻下发开启日志流指令！
        const viewers = this.logStreamViewers.get(deviceId) || 0;
        if (viewers > 0 || this.activeWebClients.has(code)) {
          socket.write(JSON.stringify({ cmd: 'start_log_stream' }) + '\n');
        }

      } catch (err: any) {
        this.logger.warn(`设备鉴权失败 [${deviceId}]: ${err.message}`);
        socket.write(JSON.stringify({ status: 'error', message: err.message || 'Auth check failed' }) + '\n');
        socket.end();
      }
      return;
    }

    // 校验：后续所有指令必须先通过 auth 握手注册
    if (!deviceId || !this.activeConnections.has(deviceId)) {
      socket.write(JSON.stringify({ status: 'error', message: 'Unauthorized. Please send auth frame first' }) + '\n');
      socket.end();
      return;
    }

    const connection = this.activeConnections.get(deviceId)!;

    // 2. 心跳机制
    if (action === 'ping') {
      connection.pingCount = (connection.pingCount || 0) + 1;
      
      if (connection.deviceInfo) {
        if (data.battery !== undefined) {
          connection.deviceInfo.battery = Number(data.battery);
        }
        if (data.cpuTemp !== undefined) {
          connection.deviceInfo.cpuTemp = Number(data.cpuTemp);
        }
        if (data.cpuLoad !== undefined) {
          connection.deviceInfo.cpuLoad = Number(data.cpuLoad);
        }
        if (data.rtt !== undefined) {
          connection.deviceInfo.rtt = Number(data.rtt);
        }
      }
      socket.write(JSON.stringify({ status: 'ok', message: 'pong' }) + '\n');

      // 广播设备状态与真实硬件更新事件
      this.deviceState$.next({
        type: 'device_status',
        code: connection.code,
        deviceId,
        payload: {
          battery: connection.deviceInfo?.battery || 100,
          cpuTemp: connection.deviceInfo?.cpuTemp || 0,
          cpuLoad: connection.deviceInfo?.cpuLoad || 0,
          rtt: connection.deviceInfo?.rtt || 0,
          status: 'online',
          ip: this.getDeviceRemoteIp(deviceId)
        }
      });
      return;
    }

    // 3. 实时日志上传 (仅用于内存实时订阅广播，不写数据库)
    if (action === 'log_chunk') {
      const logsList = data.logs || [];
      for (const log of logsList) {
        // 向全局 SSE 广播发送，通知网页端有日志传入
        this.logBroadcaster$.next({
          deviceId,
          code: connection.code,
          log: {
            id: Math.random().toString(),
            time: log.time || new Date().toTimeString().split(' ')[0],
            level: log.level || 'INFO',
            module: log.module || 'CLIENT',
            content: log.content || '',
          },
        });
      }
      return;
    }

    // 4. 收尾日志归档保存 (写数据库，作为历史记录存档)
    if (action === 'exit_log') {
      const logsList = data.logs || [];
      if (logsList.length > 0) {
        this.logger.log(`接收到设备 [${deviceId}] 退出前归档日志，行数: ${logsList.length}`);
        
        try {
          // 批量构建 ScriptLog 数据并落库
          const insertData = logsList.map((log: any) => {
            // 💡 解决物理时间戳被 TickCount() 错误还原为 1970 年的 Bug：
            // 如果日志本身有 time 字段 (HH:mm:ss 格式，代表真实时间)，我们将其与当前服务器日期拼接，还原出精确的真实时间戳
            const logDate = new Date();
            if (log.time && typeof log.time === 'string') {
              const timeParts = log.time.split(':');
              if (timeParts.length === 3) {
                const hours = parseInt(timeParts[0], 10);
                const minutes = parseInt(timeParts[1], 10);
                const seconds = parseInt(timeParts[2], 10);
                if (!isNaN(hours) && !isNaN(minutes) && !isNaN(seconds)) {
                  logDate.setHours(hours, minutes, seconds, 0);
                }
              }
            }

            return {
              deviceId,
              registerCodeId: connection.codeId,
              level: log.level || 'INFO',
              message: `[${log.module || 'CLIENT'}] ${log.content || ''}`,
              timestamp: logDate,
            };
          });

          await this.prisma.scriptLog.createMany({
            data: insertData,
          });

          this.logger.log(`设备 [${deviceId}] 的历史归档日志批量写入 PostgreSQL 成功`);
        } catch (dbErr) {
          this.logger.error(`保存归档日志至数据库出错:`, dbErr);
        }
      }
      
      socket.write(JSON.stringify({ status: 'ok', message: 'Exit logs archived successfully' }) + '\n');
      return;
    }

    socket.write(JSON.stringify({ status: 'error', message: 'Unknown action type' }) + '\n');
  }

  /**
   * 网页端打开日志页面，增加订阅计数器，若从 0 -> 1，则下发命令开启设备端的日志传输
   */
  public addViewer(deviceId: string) {
    const current = this.logStreamViewers.get(deviceId) || 0;
    this.logStreamViewers.set(deviceId, current + 1);
    
    if (current === 0) {
      const connection = this.activeConnections.get(deviceId);
      if (connection) {
        this.logger.log(`检测到网页端已打开日志视窗，向设备 [${deviceId}] 下发：start_log_stream`);
        connection.socket.write(JSON.stringify({ cmd: 'start_log_stream' }) + '\n');
      }
    }
  }

  /**
   * 网页端关闭/离开日志页面，减少订阅计数器，若降至 0，下发命令通知设备停止上传以减压
   */
  public removeViewer(deviceId: string) {
    const current = this.logStreamViewers.get(deviceId) || 0;
    if (current <= 1) {
      this.logStreamViewers.delete(deviceId);
      const connection = this.activeConnections.get(deviceId);
      if (connection) {
        this.logger.log(`检测到无网页端实时收听，向设备 [${deviceId}] 下发：stop_log_stream`);
        connection.socket.write(JSON.stringify({ cmd: 'stop_log_stream' }) + '\n');
      }
    } else {
      this.logStreamViewers.set(deviceId, current - 1);
    }
  }

  /**
   * 管理员手动在后台解绑设备时，如果当前设备在线，通知其立刻下线/退避
   */
  public forceKickDevice(deviceId: string) {
    const connection = this.activeConnections.get(deviceId);
    if (connection) {
      this.logger.log(`由于管理员解绑，强制断开设备 TCP 连接: ${deviceId}`);

      // 广播设备下线事件
      this.deviceState$.next({
        type: 'device_list',
        code: connection.code,
        deviceId,
        payload: {
          action: 'offline',
          deviceId,
        }
      });

      connection.socket.write(JSON.stringify({ cmd: 'force_kick', message: 'Device unbound by administrator' }) + '\n');
      connection.socket.end();
      this.activeConnections.delete(deviceId);
      this.logStreamViewers.delete(deviceId);
    }
  }

  /**
   * 获取当前内存中活跃的 TCP 连接总数
   */
  public getActiveConnectionsCount(): number {
    return this.activeConnections.size;
  }

  /**
   * 判定指定设备当前是否在线
   */
  public isDeviceOnline(deviceId: string): boolean {
    return this.activeConnections.has(deviceId);
  }

  /**
   * 获取在线设备的远程 IP 地址
   */
  public getDeviceRemoteIp(deviceId: string): string {
    const conn = this.activeConnections.get(deviceId);
    if (!conn || !conn.socket) return '';
    let ip = conn.socket.remoteAddress || '';
    if (ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }
    return ip;
  }

  /**
   * 获取在线设备的连接与详细信息
   */
  public getActiveConnection(deviceId: string): ClientConnection | undefined {
    return this.activeConnections.get(deviceId);
  }

  /**
   * 获取指定授权码名下的所有在线物理设备 ID 列表
   */
  public getOnlineDevicesByCode(code: string): string[] {
    const list: string[] = [];
    for (const [deviceId, conn] of this.activeConnections.entries()) {
      if (conn.code === code) {
        list.push(deviceId);
      }
    }
    return list;
  }

  /**
   * 网页端注册/加入全局长连接监视
   */
  public addWebClient(code: string) {
    this.activeWebClients.add(code);
    // 找出该 code 下所有在线设备，通知其开始上报
    for (const [deviceId, conn] of this.activeConnections.entries()) {
      if (conn.code === code) {
        this.logger.log(`检测到网页端已打开全局监视，向设备 [${deviceId}] 下发：start_log_stream`);
        conn.socket.write(JSON.stringify({ cmd: 'start_log_stream' }) + '\n');
      }
    }
  }

  /**
   * 网页端移出/取消全局长连接监视
   */
  public removeWebClient(code: string) {
    this.activeWebClients.delete(code);
    // 找出该 code 下所有在线设备，通知其停止上报以省电
    for (const [deviceId, conn] of this.activeConnections.entries()) {
      if (conn.code === code) {
        this.logger.log(`检测到网页端已关闭全局监视，向设备 [${deviceId}] 下发：stop_log_stream`);
        conn.socket.write(JSON.stringify({ cmd: 'stop_log_stream' }) + '\n');
      }
    }
  }
}



