/**
 * @file: tcp-socket.service.ts
 * @description: 原生 TCP Socket 服务端实现。用于与按键精灵客户端建立持久 TCP 握手，处理登录激活、心跳机制、实时指令下发以及智能日志上报。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { RegisterCodeService } from '../register-code/register-code.service';
import { PrismaService } from '../prisma/prisma.service';
import * as net from 'net';
import { Subject } from 'rxjs';
import * as nodemailer from 'nodemailer';

const webpush = require('web-push');

interface ClientConnection {
  socket: net.Socket;
  code: string;
  codeId: string;
  deviceId: string;
  appName?: string;
  pingCount?: number;
  isExiting?: boolean; // 标记是否优雅退出 (OnScriptExit)
  connectedAt?: Date; // 物理连接握手时间
  lastActiveTime?: Date; // 最近一次心跳上报或活跃时间
  lastTrackedAccount?: string; // 内存中记录的上一次跟踪的运行账号
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
    deviceType?: string;
    frontApp?: string;
    isLocked?: number;
    vpnStatus?: number;
    scriptMemory?: number; // 脚本当前占用内存 (KB)
    isSwitchingAccount?: number; // 是否处于换号切号状态 (1: 是)
    currentTask?: string; // 当前执行任务名称
    runningTime?: number; // 脚本已运行时间 (秒)
    currentAccount?: string; // 当前运行账号
  };
}

@Injectable()
export class TcpSocketService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(TcpSocketService.name);
  private server: net.Server;
  private readonly port = 8082;

  // 内存中维护所有活跃的 TCP 长连接: deviceId -> ConnectionInfo
  private readonly activeConnections = new Map<string, ClientConnection>();

  // 记录各设备当前网页端实时日志订阅人数: deviceId -> count
  private readonly logStreamViewers = new Map<string, number>();

  // 记录当前活跃在网页端的全局监视授权码
  private readonly activeWebClients = new Set<string>();

  // 内存中维护最近的紧急警报历史记录 (最多 200 条)
  private readonly alertHistory: Array<{
    id: string;
    deviceId: string;
    code: string;
    appName?: string;
    type: string; // offline_unexpected | launcher_detect | device_locked | vpn_disconnect | error_log_report | out_of_memory
    typeName: string; // 中文事件类型名
    message: string;
    timestamp: Date;
  }> = [];

  // 退回桌面检测防抖定时器: deviceId -> timer
  private readonly launcherTimers = new Map<string, NodeJS.Timeout>();

  // 休眠锁屏检测防抖定时器: deviceId -> timer
  private readonly lockedTimers = new Map<string, NodeJS.Timeout>();

  // ERROR 级日志告警冷喷时间限制 (5 分钟): deviceId -> timestamp
  private readonly lastErrorAlertTimes = new Map<string, number>();

  // 内存溢出告警冷喷时间限制 (10 分钟): deviceId -> timestamp
  private readonly lastMemoryAlertTimes = new Map<string, number>();

  // 设备断线判定防抖延迟定时器: deviceId -> timer
  private readonly offlineAlertTimers = new Map<string, NodeJS.Timeout>();

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

  // 全局的设备状态广播 Subject，用于推送设备上线、下线、电量变化以及告警等事件到网页端
  public readonly deviceState$ = new Subject<{
    type: 'device_list' | 'device_status' | 'device_alert';
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
    const publicKey =
      process.env.VAPID_PUBLIC_KEY ||
      'BJye1Ie6d8CnZyRtc6u2M-c2DzO1ezcVa-qowlWKfMp1WIVcuwt088swZCctnLaGDzsf7eZE71h-rc5JLsNTcgg';
    const privateKey =
      process.env.VAPID_PRIVATE_KEY ||
      '62bMGEo73JjbBfDvZ5ig7LRSbQHf2xtSGkJPyMlHmZ4';
    try {
      webpush.setVapidDetails(
        'mailto:support@example.com',
        publicKey,
        privateKey,
      );
      this.logger.log('PWA Web Push VAPID 配置成功。');
    } catch (err) {
      this.logger.error('配置 PWA Web Push VAPID 失败:', err);
    }
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
      this.logger.log(
        `TCP Socket 运行服务器启动成功，正在监听端口: ${this.port}`,
      );
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
      // 防范长乱码数据流爆内存攻击，单帧缓存限制 8KB
      if (buffer.length + data.length > 8192) {
        this.logger.debug?.(
          `客户端发送的消息缓冲超限且无换行，已被强制熔断保护。`,
        );
        socket.destroy();
        return;
      }
      buffer += data.toString('utf8');

      // 按照换行符 \n 切割消息帧以防粘包
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.substring(0, newlineIdx).trim();
        buffer = buffer.substring(newlineIdx + 1);

        if (line) {
          // 💡 快速熔断非 JSON 帧的非法网络扫描（如 HTTP GET / Host 扫描）
          if (line.charAt(0) !== '{') {
            // 降级为 debug 级别，避免生产环境 warn 日志刷屏
            this.logger.debug?.(
              `检测到非 JSON 协议帧，已断开连接。内容: ${line.substring(0, 80)}`,
            );
            socket.destroy();
            return;
          }

          try {
            await this.processMessage(socket, line, (id) => {
              deviceId = id;
            });
          } catch (err) {
            this.logger.error(`解析数据帧出错: ${line.substring(0, 150)}`, err);
            socket.write(
              JSON.stringify({
                status: 'error',
                message: 'Bad request frame format',
              }) + '\n',
            );
            socket.destroy(); // 协议异常立即切断连接，避免被无效请求占满句柄
            return;
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });

    // 超时断开逻辑 (心跳断流)
    socket.on('timeout', () => {
      this.logger.warn(
        `客户端长连接超时无心跳响应，将被强制回收: ${deviceId || '未知设备'}`,
      );
      socket.end();
    });

    socket.on('close', () => {
      if (deviceId) {
        const id = deviceId;
        this.logger.log(`客户端连接已断开，清理缓存: ${id}`);
        const conn = this.activeConnections.get(id);
        if (conn && conn.socket === socket) {
          // 如果下线前有正在活跃的账号，记录下线
          const lastAcc = conn.lastTrackedAccount;
          if (lastAcc && lastAcc !== '未登录' && lastAcc !== '') {
            this.handleAccountLogout(id, lastAcc).catch((err) => {
              this.logger.error(`清理设备 [${id}] 下线账号记录出错:`, err);
            });
          }

          // 广播设备下线事件
          this.deviceState$.next({
            type: 'device_list',
            code: conn.code,
            deviceId: id,
            payload: {
              action: 'offline',
              deviceId: id,
            },
          });

          // 意外下线判定：如果设备没有被标记为优雅退出且已经认证过，启用动态防抖延迟评估
          if (!conn.isExiting) {
            if (this.offlineAlertTimers.has(id)) {
              clearTimeout(this.offlineAlertTimers.get(id));
            }

            this.prisma.registerCode
              .findUnique({
                where: { code: conn.code },
                select: { alertConfig: true },
              })
              .then((regCode) => {
                const config = (regCode?.alertConfig as any) || {};
                if (config.offline === false) return; // 未订阅离线报警，不用设置定时器

                let timeoutMinutes = 10;
                if (typeof config.offlineTimeout === 'number') {
                  timeoutMinutes = Math.max(
                    2,
                    Math.min(60, config.offlineTimeout),
                  );
                }

                const ms = timeoutMinutes * 60 * 1000;
                this.logger.log(
                  `[离线评估] 检测到设备 [${id}] 突发断连，已启动 ${timeoutMinutes} 分钟意外离线防抖检测...`,
                );

                const timer = setTimeout(() => {
                  this.offlineAlertTimers.delete(id);

                  const currentConn = this.activeConnections.get(id);
                  if (!currentConn) {
                    this.handleUnexpectedOffline(conn, timeoutMinutes).catch(
                      (err) => {
                        this.logger.error(`执行离线报警评估出错: ${id}`, err);
                      },
                    );
                  } else {
                    this.logger.log(
                      `[离线评估] 设备 [${id}] 在 ${timeoutMinutes} 分钟防抖期内已连回，自动取消意外离线报警邮件的发送。`,
                    );
                  }
                }, ms);

                this.offlineAlertTimers.set(id, timer);
              })
              .catch((err) => {
                this.logger.error(
                  `[离线评估] 获取卡密 [${conn.code}] 离线配置失败，启用默认 10 分钟防抖判定:`,
                  err,
                );
                // 兜底 10 分钟
                const timeoutMinutes = 10;
                const ms = timeoutMinutes * 60 * 1000;
                const timer = setTimeout(() => {
                  this.offlineAlertTimers.delete(id);
                  const currentConn = this.activeConnections.get(id);
                  if (!currentConn) {
                    this.handleUnexpectedOffline(conn, timeoutMinutes).catch(
                      (errOpt) => {
                        this.logger.error(
                          `执行离线报警评估出错: ${id}`,
                          errOpt,
                        );
                      },
                    );
                  }
                }, ms);
                this.offlineAlertTimers.set(id, timer);
              });
          }

          this.activeConnections.delete(id);
          this.logStreamViewers.delete(id);
        } else {
          this.logger.log(
            `[连接断开评估] 忽略已失效/被替换的连接关闭事件: ${id}`,
          );
        }

        // 清理该设备名下的定时器，避免内存泄漏
        if (this.launcherTimers.has(id)) {
          clearTimeout(this.launcherTimers.get(id));
          this.launcherTimers.delete(id);
        }
        if (this.lockedTimers.has(id)) {
          clearTimeout(this.lockedTimers.get(id));
          this.lockedTimers.delete(id);
        }
      }
    });

    socket.on('error', (err: any) => {
      const isCommonNetError =
        err.code === 'ECONNRESET' ||
        err.code === 'EPIPE' ||
        err.code === 'ETIMEDOUT';
      if (!deviceId) {
        // 未认证设备（多为扫描器、健康探测）的常见断连网络错误，降级用 debug 记录或直接忽略
        if (isCommonNetError) {
          this.logger.debug?.(
            `未知设备的常规网络断开 (${err.code}): ${err.message}`,
          );
        } else {
          this.logger.warn(
            `未知设备物理连接发生非标准异常 (${err.code || 'ERR'}): ${err.message}`,
          );
        }
      } else {
        // 已经绑定成功注册的合法客户端
        if (isCommonNetError) {
          this.logger.warn(
            `已认证设备断连 (${err.code}): 设备ID: ${deviceId}, 描述: ${err.message}`,
          );
        } else {
          this.logger.error(
            `已认证设备连接发生严重异常: ${deviceId}`,
            err.message,
          );
        }
      }
    });
  }

  /**
   * 解析并处理单条 JSON 协议指令数据
   */
  private async processMessage(
    socket: net.Socket,
    rawMessage: string,
    setDeviceId: (id: string) => void,
  ) {
    interface MessageData {
      action?: string;
      code?: string;
      deviceId?: string;
      appName?: string;
      deviceInfo?: ClientConnection['deviceInfo'];
      battery?: number;
      frontApp?: string;
      isLocked?: number;
      vpnStatus?: number;
      scriptMemory?: number;
      isSwitchingAccount?: number;
      currentTask?: string;
      runningTime?: number;
      currentAccount?: string;
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
      socket.write(
        JSON.stringify({ status: 'error', message: 'Missing action field' }) +
          '\n',
      );
      return;
    }

    // 1. 鉴权激活握手
    if (action === 'auth') {
      if (!code || !deviceId) {
        socket.write(
          JSON.stringify({
            status: 'error',
            message: 'Auth action requires code and deviceId',
          }) + '\n',
        );
        return;
      }

      try {
        // 调用注册码服务尝试登录激活
        const authResult = await this.registerCodeService.activateCode(
          code,
          deviceId,
          appName,
          deviceInfo,
        );

        // 绑定设备标识至本地 socket 钩子
        setDeviceId(deviceId);

        // 💡 检查并清理同设备已存在的旧连接，防止内存和数据库账号流转记录出错 (解决覆盖连接时的账号下线遗漏 Bug)
        const oldConn = this.activeConnections.get(deviceId);
        if (oldConn) {
          this.logger.log(
            `[连接重置] 检测到设备 [${deviceId}] 的旧 TCP 连接仍在内存中，正在强制清理...`,
          );
          const lastAcc = oldConn.lastTrackedAccount;
          if (lastAcc && lastAcc !== '未登录' && lastAcc !== '') {
            await this.handleAccountLogout(deviceId, lastAcc).catch((err) => {
              this.logger.error(
                `清理重置设备 [${deviceId}] 下线账号记录出错:`,
                err,
              );
            });
          }
          try {
            oldConn.socket.destroy();
          } catch {
            // 忽略销毁时的错误描述
          }
        }

        // 注册到在线长连接内存映射中
        this.activeConnections.set(deviceId, {
          socket,
          code,
          codeId: authResult.codeId,
          deviceId,
          appName,
          pingCount: 0,
          deviceInfo,
          connectedAt: new Date(),
          lastActiveTime: new Date(),
        });

        // 重新连回成功，立即清除并取消 pending 的意外下线延迟告警评估
        if (this.offlineAlertTimers.has(deviceId)) {
          clearTimeout(this.offlineAlertTimers.get(deviceId));
          this.offlineAlertTimers.delete(deviceId);
          this.logger.log(
            `设备 [${deviceId}] 重新连回并鉴权成功，已取消意外离线报警评估。`,
          );
        }

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
          },
        });

        this.logger.log(
          `客户端设备通过 TCP 鉴权成功: [${deviceId}] 注册码 [${code}]`,
        );

        // 响应客户端
        socket.write(
          JSON.stringify({
            status: 'ok',
            message: 'Authentication successful',
            data: {
              expireTime: authResult.expireTime,
              maxActive: authResult.maxActive,
              usedNum: authResult.usedNum,
              allowedFeatures: (authResult as any).allowedFeatures || [],
            },
          }) + '\n',
        );

        // 💡 顺便检查一下：如果刚刚在没有连接前，已经有网页端正在监视（管理员或授权码用户），我们立刻下发开启日志流指令！
        const viewers = this.logStreamViewers.get(deviceId) || 0;
        if (viewers > 0 || this.activeWebClients.has(code)) {
          socket.write(JSON.stringify({ cmd: 'start_log_stream' }) + '\n');
        }
      } catch (err: any) {
        this.logger.warn(`设备鉴权失败 [${deviceId}]: ${err.message}`);
        socket.write(
          JSON.stringify({
            status: 'error',
            message: err.message || 'Auth check failed',
          }) + '\n',
        );
        socket.end();
      }
      return;
    }

    // 校验：后续所有指令必须先通过 auth 握手注册
    if (!deviceId || !this.activeConnections.has(deviceId)) {
      socket.write(
        JSON.stringify({
          status: 'error',
          message: 'Unauthorized. Please send auth frame first',
        }) + '\n',
      );
      socket.end();
      return;
    }

    const connection = this.activeConnections.get(deviceId)!;
    connection.lastActiveTime = new Date();

    // 1.5 客户端登录前，主动防重复查重校验
    if (action === 'check_account_status') {
      const checkAcc = String(data.currentAccount || '').trim();
      if (!checkAcc || checkAcc === '未登录') {
        socket.write(
          JSON.stringify({
            status: 'ok',
            action: 'check_account_status',
            account: checkAcc,
            isOccupied: false,
          }) + '\n',
        );
        return;
      }

      let isOccupied = false;
      for (const [
        otherDeviceId,
        otherConn,
      ] of this.activeConnections.entries()) {
        if (otherDeviceId !== deviceId && otherConn.code === connection.code) {
          const otherAccount = otherConn.deviceInfo?.currentAccount;
          if (otherAccount && otherAccount.trim() === checkAcc) {
            isOccupied = true;
            break;
          }
        }
      }

      socket.write(
        JSON.stringify({
          status: 'ok',
          action: 'check_account_status',
          account: checkAcc,
          isOccupied: isOccupied,
        }) + '\n',
      );
      return;
    }

    // 2. 心跳机制
    if (action === 'ping') {
      connection.pingCount = (connection.pingCount || 0) + 1;

      if (!connection.deviceInfo) {
        connection.deviceInfo = {
          name: `设备 (${deviceId.slice(0, 8)})`,
          model: '未知型号',
          os: 'android',
          osVersion: '未知版本',
          resolution: '0x0',
          dpi: 0,
          isRoot: 0,
          battery: 100,
          ip: '0.0.0.0',
        };
      }

      // 备份旧状态，用于变化感知与报警判断
      const oldVpnStatus = connection.deviceInfo.vpnStatus;
      const oldFrontApp = connection.deviceInfo.frontApp;
      const oldIsLocked = connection.deviceInfo.isLocked;

      if (data.battery !== undefined) {
        connection.deviceInfo.battery = Number(data.battery);
      }
      if (data.frontApp !== undefined) {
        connection.deviceInfo.frontApp = String(data.frontApp);
      }
      if (data.isLocked !== undefined) {
        connection.deviceInfo.isLocked = Number(data.isLocked);
      }
      if (data.vpnStatus !== undefined) {
        connection.deviceInfo.vpnStatus = Number(data.vpnStatus);
      }
      if (data.scriptMemory !== undefined) {
        (connection.deviceInfo as any).scriptMemory = Number(data.scriptMemory);
      }
      if (data.isSwitchingAccount !== undefined) {
        (connection.deviceInfo as any).isSwitchingAccount = Number(
          data.isSwitchingAccount,
        );
      }
      if (data.currentTask !== undefined) {
        connection.deviceInfo.currentTask = String(data.currentTask);
      }
      if (data.runningTime !== undefined) {
        connection.deviceInfo.runningTime = Number(data.runningTime);
      }
      if (data.currentAccount !== undefined) {
        const newAccount = String(data.currentAccount).trim() || '未登录';
        const oldAccount = connection.lastTrackedAccount;

        if (oldAccount === undefined) {
          connection.lastTrackedAccount = newAccount;
          if (newAccount !== '未登录' && newAccount !== '') {
            this.handleAccountLogin(
              connection.deviceId,
              connection.code,
              newAccount,
            ).catch((err) => {
              this.logger.error(
                `记录账号上线出错 [${connection.deviceId}]:`,
                err,
              );
            });
          }
        } else if (oldAccount !== newAccount) {
          this.logger.log(
            `设备 [${connection.deviceId}] 账号流转: [${oldAccount}] -> [${newAccount}]`,
          );
          if (oldAccount !== '未登录' && oldAccount !== '') {
            this.handleAccountLogout(connection.deviceId, oldAccount).catch(
              (err) => {
                this.logger.error(
                  `记录账号下线出错 [${connection.deviceId}]:`,
                  err,
                );
              },
            );
          }
          if (newAccount !== '未登录' && newAccount !== '') {
            this.handleAccountLogin(
              connection.deviceId,
              connection.code,
              newAccount,
            ).catch((err) => {
              this.logger.error(
                `记录账号上线出错 [${connection.deviceId}]:`,
                err,
              );
            });
          }
          connection.lastTrackedAccount = newAccount;
        }

        connection.deviceInfo.currentAccount = newAccount;

        // 【新增】：被动冲突防御检查
        if (newAccount !== '未登录' && newAccount !== '') {
          this.checkAccountSharingConflict(connection, newAccount).catch(
            (err) => {
              this.logger.error(`执行被动账号防多开冲突评估出错:`, err);
            },
          );
        }
      }

      socket.write(JSON.stringify({ status: 'ok', message: 'pong' }) + '\n');

      const curFront = connection.deviceInfo.frontApp || '';
      const curLocked = connection.deviceInfo.isLocked;
      const curVpn = connection.deviceInfo.vpnStatus;
      const isSwitching =
        (connection.deviceInfo as any).isSwitchingAccount === 1;

      // 💡 2.1 退回桌面防抖检测 (60秒防抖且过滤切号状态)
      const isLauncherPkg = (pkg: string) => {
        const p = pkg.toLowerCase();
        return (
          p.includes('launcher') ||
          p.includes('desktop') ||
          p.includes('miui.home') ||
          p === 'com.android.systemui'
        );
      };

      if (isLauncherPkg(curFront) && !isSwitching) {
        if (!this.launcherTimers.has(deviceId)) {
          const timer = setTimeout(() => {
            this.handleLauncherDetect(connection, curFront).catch((err) => {
              this.logger.error(`执行桌面异常检测评估出错: ${deviceId}`, err);
            });
            this.launcherTimers.delete(deviceId);
          }, 60000);
          this.launcherTimers.set(deviceId, timer);
        }
      } else {
        // 如果切回游戏或者标记为切号中，立即取消桌面异常防抖定时器
        if (this.launcherTimers.has(deviceId)) {
          clearTimeout(this.launcherTimers.get(deviceId));
          this.launcherTimers.delete(deviceId);
        }
      }

      // 💡 2.2 休眠锁屏防抖检测 (30秒防抖)
      if (curLocked === 1) {
        if (!this.lockedTimers.has(deviceId)) {
          const timer = setTimeout(() => {
            this.handleDeviceLocked(connection).catch((err) => {
              this.logger.error(`执行锁屏检测评估出错: ${deviceId}`, err);
            });
            this.lockedTimers.delete(deviceId);
          }, 30000);
          this.lockedTimers.set(deviceId, timer);
        }
      } else {
        // 解锁后立即清除定时器
        if (this.lockedTimers.has(deviceId)) {
          clearTimeout(this.lockedTimers.get(deviceId));
          this.lockedTimers.delete(deviceId);
        }
      }

      // 💡 2.3 代理 (VPN) 断开检测 (即时触发，过滤切号)
      if (oldVpnStatus === 1 && curVpn === 0 && !isSwitching) {
        this.handleVpnDisconnect(connection).catch((err) => {
          this.logger.error(`执行代理断开评估出错: ${deviceId}`, err);
        });
      }

      // 💡 2.4 脚本内存超限泄漏预警
      if (data.scriptMemory !== undefined) {
        this.handleOutOfMemory(connection, Number(data.scriptMemory)).catch(
          (err) => {
            this.logger.error(`执行内存超限评估出错: ${deviceId}`, err);
          },
        );
      }

      // 广播设备状态与真实硬件更新事件到网页前端
      this.deviceState$.next({
        type: 'device_status',
        code: connection.code,
        deviceId,
        payload: {
          battery: connection.deviceInfo.battery || 100,
          frontApp: curFront || 'unknown',
          currentTask: connection.deviceInfo.currentTask || '常规挂机',
          currentAccount: connection.deviceInfo.currentAccount || '未登录',
          runningTime: connection.deviceInfo.runningTime || 0,
          isLocked: curLocked === 1,
          vpnStatus: curVpn === 1,
          scriptMemory: (connection.deviceInfo as any).scriptMemory || 0,
          isSwitchingAccount: isSwitching,
          status: 'online',
          ip: this.getDeviceRemoteIp(deviceId),
          heartbeatsCount: connection.pingCount || 0,
        },
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

        // 💡 3.1 监听并评估 ERROR 日志告警 (含5分钟发信冷喷)
        if (log.level === 'ERROR') {
          this.handleErrorLogAlert(connection, log.content || '').catch(
            (err) => {
              this.logger.error(`执行ERROR日志报警评估出错: ${deviceId}`, err);
            },
          );
        }
      }
      return;
    }

    // 4. 收尾日志归档保存 (写数据库，作为历史记录存档)
    if (action === 'exit_log' || action === 'archive_log') {
      if (action === 'exit_log') {
        // 标记优雅退出，防止触发意外下线离线告警
        connection.isExiting = true;
      }

      let logsList = data.logs || [];
      if (logsList.length > 50) {
        this.logger.warn(
          `设备 [${deviceId}] 批量上报日志条数超限 (${logsList.length} 条)，已截断至前 50 条`,
        );
        logsList = logsList.slice(0, 50);
      }

      if (logsList.length > 0) {
        this.logger.log(
          `接收到设备 [${deviceId}] 批量归档日志，类型: ${action}，行数: ${logsList.length}`,
        );

        try {
          // 批量构建 ScriptLog 数据并落库
          const insertData = logsList.map((log: any) => {
            const logObj = log as {
              timestamp?: unknown;
              time?: unknown;
              level?: unknown;
              module?: unknown;
              content?: unknown;
            };
            let logDate = new Date();
            if (logObj.time && typeof logObj.time === 'string') {
              const timeParts = logObj.time.split(':');
              if (timeParts.length === 3) {
                const hours = parseInt(timeParts[0], 10);
                const minutes = parseInt(timeParts[1], 10);
                const seconds = parseInt(timeParts[2], 10);
                if (!isNaN(hours) && !isNaN(minutes) && !isNaN(seconds)) {
                  try {
                    // 获取当前服务器在东八区（北京时间）对应的年月日
                    const formatter = new Intl.DateTimeFormat('en-US', {
                      timeZone: 'Asia/Shanghai',
                      year: 'numeric',
                      month: '2-digit',
                      day: '2-digit',
                    });
                    const parts = formatter.formatToParts(new Date());
                    const year = parts.find((p) => p.type === 'year')?.value;
                    const month = parts.find((p) => p.type === 'month')?.value;
                    const day = parts.find((p) => p.type === 'day')?.value;

                    // 计算毫秒数：从客户端日志自带的 timestamp (TickCount) 取余 1000 得到相对毫秒
                    const clientMs =
                      typeof logObj.timestamp === 'number'
                        ? logObj.timestamp % 1000
                        : 0;
                    const msStr = String(clientMs).padStart(3, '0');

                    if (year && month && day) {
                      // 拼接为标准的东八区 ISO 字符串（带毫秒），转换为绝对的 Date 对象
                      logDate = new Date(
                        `${year}-${month}-${day}T${logObj.time}.${msStr}+08:00`,
                      );
                    } else {
                      logDate.setHours(hours, minutes, seconds, clientMs);
                    }

                    // 防御性时间校验：如果合成 of 日志时间比当前服务器时间大过 5 分钟，说明该日志是在跨天交界处上报的昨日日志，需向前推回 1 天
                    const now = new Date();
                    if (logDate.getTime() > now.getTime() + 5 * 60 * 1000) {
                      logDate.setDate(logDate.getDate() - 1);
                    }
                  } catch {
                    const clientMs =
                      typeof logObj.timestamp === 'number'
                        ? logObj.timestamp % 1000
                        : 0;
                    logDate.setHours(hours, minutes, seconds, clientMs);
                  }
                }
              }
            }

            let contentStr =
              typeof logObj.content === 'string' ? logObj.content : '';
            if (contentStr.length > 300) {
              contentStr = contentStr.substring(0, 300) + '...[已截断]';
            }

            const moduleStr =
              typeof logObj.module === 'string' ? logObj.module : 'CLIENT';
            const levelStr =
              typeof logObj.level === 'string' ? logObj.level : 'INFO';

            return {
              deviceId,
              registerCodeId: connection.codeId,
              level: levelStr,
              message: `[${moduleStr}] ${contentStr}`,
              timestamp: logDate,
            };
          });

          await this.prisma.scriptLog.createMany({
            data: insertData,
          });

          this.logger.log(
            `设备 [${deviceId}] 的历史归档日志批量写入 PostgreSQL 成功`,
          );
        } catch (dbErr) {
          this.logger.error(`保存归档日志至数据库出错:`, dbErr);
        }
      }

      socket.write(
        JSON.stringify({
          status: 'ok',
          message: 'Exit logs archived successfully',
        }) + '\n',
      );
      return;
    }

    socket.write(
      JSON.stringify({ status: 'error', message: 'Unknown action type' }) +
        '\n',
    );
  }

  /**
   * 网页端打开日志页面，增加订阅计数器，若从 0 -> 1，且无全局大屏监视，则下发命令开启设备端的日志传输
   */
  public addViewer(deviceId: string) {
    const current = this.logStreamViewers.get(deviceId) || 0;
    this.logStreamViewers.set(deviceId, current + 1);

    if (current === 0) {
      const connection = this.activeConnections.get(deviceId);
      if (connection) {
        const hasWebClient = connection.code
          ? this.activeWebClients.has(connection.code)
          : false;
        if (!hasWebClient) {
          this.logger.log(
            `检测到网页端已打开日志视窗，且当前无全局大屏监视，向设备 [${deviceId}] 下发：start_log_stream`,
          );
          connection.socket.write(
            JSON.stringify({ cmd: 'start_log_stream' }) + '\n',
          );
        } else {
          this.logger.log(
            `网页端已打开日志视窗，设备 [${deviceId}] 当前已处于全局大屏监视状态，无需重复下发 start_log_stream`,
          );
        }
      }
    }
  }

  /**
   * 网页端关闭/离开日志页面，减少订阅计数器，若降至 0，且无全局大屏监视，则下发命令通知设备停止上传以减压
   */
  public removeViewer(deviceId: string) {
    const current = this.logStreamViewers.get(deviceId) || 0;
    if (current <= 1) {
      this.logStreamViewers.delete(deviceId);
      const connection = this.activeConnections.get(deviceId);
      if (connection) {
        const hasWebClient = connection.code
          ? this.activeWebClients.has(connection.code)
          : false;
        if (!hasWebClient) {
          this.logger.log(
            `检测到无网页端实时收听，且当前无全局大屏监视，向设备 [${deviceId}] 下发：stop_log_stream`,
          );
          connection.socket.write(
            JSON.stringify({ cmd: 'stop_log_stream' }) + '\n',
          );
        } else {
          this.logger.log(
            `检测到网页端单设备监听已移除，但由于当前该注册码存在全局大屏监视，设备 [${deviceId}] 保持日志上报`,
          );
        }
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
        },
      });

      connection.socket.write(
        JSON.stringify({
          cmd: 'force_kick',
          message: 'Device unbound by administrator',
        }) + '\n',
      );
      connection.socket.end();
      this.activeConnections.delete(deviceId);
      this.logStreamViewers.delete(deviceId);
    }
  }

  /**
   * 标记设备为优雅退出状态，防止其下线后触发超时报警邮件
   */
  public markDeviceAsExiting(deviceId: string) {
    const connection = this.activeConnections.get(deviceId);
    if (connection) {
      this.logger.log(`设备标记为优雅退出，防止离线报警: ${deviceId}`);
      connection.isExiting = true;
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
        const viewerCount = this.logStreamViewers.get(deviceId) || 0;
        if (viewerCount === 0) {
          this.logger.log(
            `检测到网页端已打开全局监视，向设备 [${deviceId}] 下发：start_log_stream`,
          );
          conn.socket.write(JSON.stringify({ cmd: 'start_log_stream' }) + '\n');
        } else {
          this.logger.log(
            `网页端已打开全局监视，但由于设备 [${deviceId}] 存在网页端单设备收听，保持上报状态`,
          );
        }
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
        const viewerCount = this.logStreamViewers.get(deviceId) || 0;
        if (viewerCount === 0) {
          this.logger.log(
            `检测到网页端已关闭全局监视，向设备 [${deviceId}] 下发：stop_log_stream`,
          );
          conn.socket.write(JSON.stringify({ cmd: 'stop_log_stream' }) + '\n');
        } else {
          this.logger.log(
            `网页端已关闭全局监视，但由于设备 [${deviceId}] 仍存在网页端单设备收听，保持日志上报`,
          );
        }
      }
    }
  }

  /**
   * 内存中维护最近的紧急警报历史记录 (供前端大屏首次加载和实时推送)
   */
  public getAlertHistory() {
    return this.alertHistory;
  }

  /**
   * 异步发送邮件警报。受全局 `alert_mail_enabled` 控制。
   */
  private async sendAlertEmail(code: string, subject: string, html: string) {
    try {
      // 1. 查询系统开启状态
      const alertEnabledSetting = await this.prisma.systemSetting.findUnique({
        where: { key: 'alert_mail_enabled' },
      });
      if (alertEnabledSetting?.value !== 'true') {
        this.logger.warn(
          `[邮件警报降级] 全局邮件警报开关 alert_mail_enabled 未开启，跳过发信。主题: ${subject}`,
        );
        return;
      }

      // 2. 查询卡密绑定的接收邮箱
      const regCode = await this.prisma.registerCode.findUnique({
        where: { code },
        select: { alertEmail: true },
      });
      const alertEmail = regCode?.alertEmail;
      if (!alertEmail) {
        this.logger.warn(
          `[邮件警报降级] 卡密 [${code}] 未配置警报接收邮箱 alertEmail，跳过发信。`,
        );
        return;
      }

      // 3. 查询发信 SMTP 凭证
      const smtpSettings = await this.prisma.systemSetting.findMany({
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
      smtpSettings.forEach((item) => {
        config[item.key] = item.value;
      });

      const mailEnabled = config['mail_enabled'] === 'true';
      const smtpHost = config['smtp_host'];
      const smtpPort = config['smtp_port'];
      const smtpUser = config['smtp_user'];
      const smtpPass = config['smtp_pass'];
      const smtpFrom = config['smtp_from'] || smtpUser;

      if (!mailEnabled || !smtpHost || !smtpPort || !smtpUser || !smtpPass) {
        this.logger.warn(`[邮件警报降级] SMTP 服务器配置未完善，跳过发信。`);
        return;
      }

      // 4. 发信
      const port = parseInt(smtpPort, 10) || 465;
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port,
        secure: port === 465,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      });

      // 支持分号或逗号分隔多个邮箱
      const toEmails = alertEmail
        .split(/[;,]/)
        .map((e) => e.trim())
        .filter(Boolean);
      if (toEmails.length === 0) return;

      await transporter.sendMail({
        from: smtpFrom,
        to: toEmails,
        subject,
        html,
      });
      this.logger.log(`[SMTP] 警报邮件已成功投递至: ${toEmails.join(', ')}`);
    } catch (err) {
      this.logger.error(`[SMTP] 警报邮件投递异常:`, err);
    }
  }

  /**
   * 将警报保存至内存历史，并通过 SSE 广播到前端
   */
  private addAlertToHistory(
    conn: ClientConnection,
    type: string,
    typeName: string,
    message: string,
  ) {
    const alertItem = {
      id: Math.random().toString(36).slice(2, 9),
      deviceId: conn.deviceId,
      code: conn.code,
      appName: conn.appName || '通用',
      type,
      typeName,
      message,
      timestamp: new Date(),
    };

    // 塞入历史
    this.alertHistory.unshift(alertItem);
    if (this.alertHistory.length > 200) {
      this.alertHistory.pop();
    }

    // 广播给网页端 SSE
    this.deviceState$.next({
      type: 'device_alert',
      code: conn.code,
      deviceId: conn.deviceId,
      payload: alertItem,
    });

    // 触发 PWA 桌面气泡推送
    this.sendWebPushNotification(conn.code, typeName, message).catch((err) => {
      this.logger.error(`触发 PWA Web Push 警报发送异常:`, err);
    });
  }

  /**
   * 向卡密订阅的所有 PWA 客户端发送桌面通知
   */
  private async sendWebPushNotification(
    code: string,
    typeName: string,
    message: string,
  ) {
    try {
      const regCode = await this.prisma.registerCode.findUnique({
        where: { code },
        select: { pushSubscriptions: true },
      });
      if (!regCode) return;

      const subscriptions = (regCode.pushSubscriptions as any[]) || [];
      if (subscriptions.length === 0) return;

      const payload = JSON.stringify({
        title: `🔴 挂机警报 - ${typeName}`,
        body: message,
        icon: '/icons/icon-192x192.png',
        badge: '/icons/icon-192x192.png',
        data: {
          url: `/user/app/general`, // 默认跳转地址
        },
      });

      this.logger.log(
        `开始向卡密 [${code}] 的 ${subscriptions.length} 个 PWA 设备推送警报`,
      );

      const promises = subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
        } catch (err: any) {
          // 如果通知服务返回 410 (Gone) 或 404，表明该订阅凭证已失效/被用户注销，自动将其从数据库清除
          if (err.statusCode === 410 || err.statusCode === 404) {
            this.logger.warn(`PWA 订阅凭证失效，准备自动清除: ${sub.endpoint}`);
            const fresh = await this.prisma.registerCode.findUnique({
              where: { code },
              select: { pushSubscriptions: true },
            });
            if (fresh) {
              const freshSubs = (fresh.pushSubscriptions as any[]) || [];
              const filtered = freshSubs.filter(
                (s: any) => s.endpoint !== sub.endpoint,
              );
              await this.prisma.registerCode
                .update({
                  where: { code },
                  data: { pushSubscriptions: filtered },
                })
                .catch(() => {});
            }
          } else {
            this.logger.error(`向 ${sub.endpoint} 发送 Web Push 失败:`, err);
          }
        }
      });

      await Promise.all(promises);
    } catch (err) {
      this.logger.error(`执行 PWA 桌面推送异常:`, err);
    }
  }

  // 1. 意外断开
  private async handleUnexpectedOffline(
    conn: ClientConnection,
    timeoutMinutes: number = 10,
  ) {
    // 检查订阅
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code: conn.code },
      select: { alertConfig: true },
    });
    const config = (regCode?.alertConfig as any) || {};
    if (config.offline === false) return; // 未订阅

    const name = conn.deviceInfo?.name || `设备 (${conn.deviceId.slice(0, 8)})`;
    const seconds = timeoutMinutes * 60;
    const message = `设备 [${name}] 连续超过 ${seconds} 秒未响应心跳（或 TCP 连接在运行中异常中断），且下线前无 OnScriptExit() 优雅退出日志，判定为突发离线/死机异常。`;

    this.addAlertToHistory(conn, 'offline_unexpected', '设备意外离线', message);

    const subject = `🔴 紧急警报：设备意外断线/死机 [${name}]`;
    const html = `
      <div style="padding: 24px; font-family: sans-serif; background-color: #fef2f2; color: #991b1b; border-radius: 8px; border: 1px solid #fee2e2;">
        <h2 style="color: #dc2626; margin-bottom: 16px;">🔴 设备突发掉线或死机警告</h2>
        <p style="font-size: 14px;">您的挂机设备因异常中断与服务器断开连接。详情如下：</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 16px 0;">
          <tr><td style="padding: 6px; font-weight: bold; width: 100px;">激活码：</td><td style="padding: 6px; color: #111827;">${conn.code}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">设备名称：</td><td style="padding: 6px; color: #111827;">${name}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">设备ID：</td><td style="padding: 6px; color: #111827;">${conn.deviceId}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">应用包名：</td><td style="padding: 6px; color: #111827;">${conn.appName || '未记录'}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">告警原因：</td><td style="padding: 6px; color: #dc2626;">未收到正常停止指令即发生连接断开，疑似脚本或网络崩溃。</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">判定时长：</td><td style="padding: 6px; color: #111827;">连续超过 ${seconds} 秒未响应心跳</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">离线时间：</td><td style="padding: 6px; color: #111827;">${new Date().toLocaleString()}</td></tr>
        </table>
        <p style="font-size: 12px; color: #6b7280; margin-top: 24px;">请前往云手机/模拟器后台排查网络连接或游戏软件运行状况。</p>
      </div>
    `;

    await this.sendAlertEmail(conn.code, subject, html);
  }

  // 2. 退回桌面
  private async handleLauncherDetect(conn: ClientConnection, frontApp: string) {
    // 再次检查此时是否为切号或已经恢复，防止在防抖时间里切回
    if (conn.deviceInfo?.isSwitchingAccount === 1) return;
    const isLauncher = (pkg: string) => {
      const p = pkg.toLowerCase();
      return (
        p.includes('launcher') ||
        p.includes('desktop') ||
        p.includes('miui.home') ||
        p === 'com.android.systemui'
      );
    };
    if (!isLauncher(conn.deviceInfo?.frontApp || '')) return;

    const regCode = await this.prisma.registerCode.findUnique({
      where: { code: conn.code },
      select: { alertConfig: true },
    });
    const config = (regCode?.alertConfig as any) || {};
    if (config.launcher === false) return; // 未订阅

    const name = conn.deviceInfo?.name || `设备 (${conn.deviceId.slice(0, 8)})`;
    const message = `警告：设备 [${name}] 的当前最前端应用变更为桌面启动器 [${frontApp}]，已在最前端停留超过 60 秒。判定为游戏意外闪退或强退到桌面。`;

    this.addAlertToHistory(conn, 'launcher_detect', '异常退回桌面', message);

    const subject = `⚠️ 告警：设备异常闪退到桌面 [${name}]`;
    const html = `
      <div style="padding: 24px; font-family: sans-serif; background-color: #fffbeb; color: #92400e; border-radius: 8px; border: 1px solid #fef3c7;">
        <h2 style="color: #d97706; margin-bottom: 16px;">⚠️ 挂机脚本闪退桌面警告</h2>
        <p style="font-size: 14px;">您的挂机设备检测到已退出游戏界面。详情如下：</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 16px 0;">
          <tr><td style="padding: 6px; font-weight: bold; width: 100px;">激活码：</td><td style="padding: 6px; color: #111827;">${conn.code}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">设备名称：</td><td style="padding: 6px; color: #111827;">${name}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">当前最前包名：</td><td style="padding: 6px; color: #dc2626; font-family: monospace;">${frontApp}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">告警原因：</td><td style="padding: 6px; color: #b45309;">异常退回到手机桌面，挂机可能已经中断。</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">上报时间：</td><td style="padding: 6px; color: #111827;">${new Date().toLocaleString()}</td></tr>
        </table>
        <p style="font-size: 12px; color: #6b7280; margin-top: 24px;">若此行为正常游戏切换，请忽略此邮件或在后台微调配置。</p>
      </div>
    `;

    await this.sendAlertEmail(conn.code, subject, html);
  }

  // 3. 休眠锁屏
  private async handleDeviceLocked(conn: ClientConnection) {
    if (conn.deviceInfo?.isLocked !== 1) return;

    const regCode = await this.prisma.registerCode.findUnique({
      where: { code: conn.code },
      select: { alertConfig: true },
    });
    const config = (regCode?.alertConfig as any) || {};
    if (config.locked === false) return; // 未订阅

    const name = conn.deviceInfo?.name || `设备 (${conn.deviceId.slice(0, 8)})`;
    const message = `警告：设备 [${name}] 检测到锁屏状态 (isLocked === 1) 持续超过 30 秒，可能导致点击与找图功能失效。`;

    this.addAlertToHistory(conn, 'device_locked', '设备休眠锁屏', message);

    const subject = `🔒 警告：设备已被锁屏 [${name}]`;
    const html = `
      <div style="padding: 24px; font-family: sans-serif; background-color: #f1f5f9; color: #334155; border-radius: 8px; border: 1px solid #e2e8f0;">
        <h2 style="color: #475569; margin-bottom: 16px;">🔒 设备锁屏状态警告</h2>
        <p style="font-size: 14px;">挂机设备检测到已经处于黑屏/锁屏状态，会阻断大多数找图或按键操作。详情如下：</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 16px 0;">
          <tr><td style="padding: 6px; font-weight: bold; width: 100px;">设备名称：</td><td style="padding: 6px; color: #111827;">${name}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">激活码：</td><td style="padding: 6px; color: #111827;">${conn.code}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">告警原因：</td><td style="padding: 6px; color: #475569;">屏幕锁屏，导致脚本无法在物理图层正常渲染和交互。</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">时间：</td><td style="padding: 6px; color: #111827;">${new Date().toLocaleString()}</td></tr>
        </table>
        <p style="font-size: 12px; color: #6b7280; margin-top: 24px;">建议关闭手机的“自动休眠”、“自动锁屏”选项。</p>
      </div>
    `;

    await this.sendAlertEmail(conn.code, subject, html);
  }

  // 4. VPN 断开
  private async handleVpnDisconnect(conn: ClientConnection) {
    if (conn.deviceInfo?.isSwitchingAccount === 1) return; // 切号时不报

    const regCode = await this.prisma.registerCode.findUnique({
      where: { code: conn.code },
      select: { alertConfig: true },
    });
    const config = (regCode?.alertConfig as any) || {};
    if (config.vpn === false) return; // 未订阅

    const name = conn.deviceInfo?.name || `设备 (${conn.deviceId.slice(0, 8)})`;
    const message = `致命警告：设备 [${name}] 网络代理 (VPN) 已断开，当前回落为直连网络。存在封号关联风险，请注意防封！`;

    this.addAlertToHistory(conn, 'vpn_disconnect', '代理(VPN)断开', message);

    const subject = `🛡️ 致命警告：代理(VPN)已断开 [${name}]`;
    const html = `
      <div style="padding: 24px; font-family: sans-serif; background-color: #fff1f2; color: #9f1239; border-radius: 8px; border: 1px solid #ffe4e6;">
        <h2 style="color: #e11d48; margin-bottom: 16px;">🛡️ 致命告警：网络代理 (VPN) 断开</h2>
        <p style="font-size: 14px;"><strong>防封号红线：</strong>您的设备已丢失 VPN 保护。详情如下：</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 16px 0;">
          <tr><td style="padding: 6px; font-weight: bold; width: 100px;">设备名称：</td><td style="padding: 6px; color: #111827;">${name}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">激活码：</td><td style="padding: 6px; color: #111827;">${conn.code}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">代理状态：</td><td style="padding: 6px; color: #e11d48; font-weight: bold;">已断开 (回落至直连 IP: ${this.getDeviceRemoteIp(conn.deviceId)})</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">时间：</td><td style="padding: 6px; color: #111827;">${new Date().toLocaleString()}</td></tr>
        </table>
        <p style="font-size: 12px; color: #6b7280; margin-top: 24px;">为了避免挂机账号关联封禁，请立即连上代理并检查网络线路。</p>
      </div>
    `;

    await this.sendAlertEmail(conn.code, subject, html);
  }

  // 5. 内存超限
  private async handleOutOfMemory(
    conn: ClientConnection,
    currentMemory: number,
  ) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code: conn.code },
      select: { alertConfig: true },
    });
    const config = (regCode?.alertConfig as any) || {};
    const limit = Number(config.memoryLimit) || 153600; // 默认 150MB

    if (currentMemory <= limit) return;

    // 10 分钟冷喷限制
    const now = Date.now();
    const lastTime = this.lastMemoryAlertTimes.get(conn.deviceId) || 0;
    if (now - lastTime < 600000) return;
    this.lastMemoryAlertTimes.set(conn.deviceId, now);

    const name = conn.deviceInfo?.name || `设备 (${conn.deviceId.slice(0, 8)})`;
    const message = `预警：设备 [${name}] 当前脚本占用内存 ${(currentMemory / 1024).toFixed(1)}MB，超过设定的阈值 ${(limit / 1024).toFixed(1)}MB。面临闪退或崩溃隐患。`;

    this.addAlertToHistory(conn, 'out_of_memory', '内存泄漏预警', message);

    const subject = `🧠 预警：挂机脚本内存使用超限 [${name}]`;
    const html = `
      <div style="padding: 24px; font-family: sans-serif; background-color: #faf5ff; color: #6b21a8; border-radius: 8px; border: 1px solid #f3e8ff;">
        <h2 style="color: #9333ea; margin-bottom: 16px;">🧠 脚本内存泄漏超限预警</h2>
        <p style="font-size: 14px;">设备脚本内存持续攀升。详情如下：</p>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 16px 0;">
          <tr><td style="padding: 6px; font-weight: bold; width: 120px;">设备名称：</td><td style="padding: 6px; color: #111827;">${name}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">当前内存占用：</td><td style="padding: 6px; color: #dc2626; font-weight: bold;">${(currentMemory / 1024).toFixed(1)} MB</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">预设上限阀值：</td><td style="padding: 6px; color: #111827;">${(limit / 1024).toFixed(1)} MB</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">时间：</td><td style="padding: 6px; color: #111827;">${new Date().toLocaleString()}</td></tr>
        </table>
        <p style="font-size: 12px; color: #6b7280; margin-top: 24px;">若出现泄漏，可能是循环或闭包中大变量未释放，建议适时重启脚本或排查代码。</p>
      </div>
    `;

    await this.sendAlertEmail(conn.code, subject, html);
  }

  // 6. ERROR 日志上报
  private async handleErrorLogAlert(
    conn: ClientConnection,
    logContent: string,
  ) {
    const regCode = await this.prisma.registerCode.findUnique({
      where: { code: conn.code },
      select: { alertConfig: true },
    });
    const config = (regCode?.alertConfig as any) || {};
    if (config.errorLog === false) return; // 未订阅

    // 5 分钟冷喷限制
    const now = Date.now();
    const lastTime = this.lastErrorAlertTimes.get(conn.deviceId) || 0;
    if (now - lastTime < 300000) return;
    this.lastErrorAlertTimes.set(conn.deviceId, now);

    const name = conn.deviceInfo?.name || `设备 (${conn.deviceId.slice(0, 8)})`;
    let message = `业务告警：设备 [${name}] 发生运行异常。内容: ${logContent}`;
    let alertType = 'error_log_report';
    let alertTypeName = '脚本运行卡死';

    if (logContent.startsWith('CRASH_REPORT:')) {
      alertType = 'script_crash';
      alertTypeName = '脚本运行崩溃';
      const taskMatch = logContent.match(/任务=\[(.*?)\]/);
      const moduleMatch = logContent.match(/模块=\[(.*?)\]/);
      const accountMatch = logContent.match(/账号=\[(.*?)\]/);
      const reasonMatch = logContent.match(/原因=\[(.*?)\]/);
      const task = taskMatch ? taskMatch[1] : '未知任务';
      const mModule = moduleMatch ? moduleMatch[1] : '未知模块';
      const account = accountMatch ? accountMatch[1] : '未知账号';
      const reason = reasonMatch ? reasonMatch[1] : '未知原因';
      const lineMatch = reason.match(/:(\d+):/);
      const lineNo = lineMatch ? `第 ${lineMatch[1]} 行` : '未知行';

      message = `崩溃警报：设备 [${name}] 正在执行 [${task}] (${mModule}) 任务时（当前账号: ${account}）发生致命崩溃。出错代码行数：${lineNo}。错误原因: ${reason}`;
    }

    this.addAlertToHistory(conn, alertType, alertTypeName, message);

    const subject = `❌ 业务报警：挂机脚本发生致命异常/卡死错误 [${name}]`;
    const html = `
      <div style="padding: 24px; font-family: sans-serif; background-color: #fef2f2; color: #991b1b; border-radius: 8px; border: 1px solid #fee2e2;">
        <h2 style="color: #dc2626; margin-bottom: 16px;">❌ 挂机脚本上报 ERROR 日志</h2>
        <p style="font-size: 14px;">脚本运行至关键流程时发生阻断错误，上报内容如下：</p>
        <div style="background: #ffffff; padding: 12px; border: 1px solid #f87171; border-radius: 4px; font-family: monospace; font-size: 13px; color: #b91c1c; margin: 16px 0; word-break: break-all;">
          ${logContent}
        </div>
        <table style="width: 100%; border-collapse: collapse; font-size: 13px; margin: 16px 0;">
          <tr><td style="padding: 6px; font-weight: bold; width: 100px;">设备名称：</td><td style="padding: 6px; color: #111827;">${name}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">激活码：</td><td style="padding: 6px; color: #111827;">${conn.code}</td></tr>
          <tr><td style="padding: 6px; font-weight: bold;">时间：</td><td style="padding: 6px; color: #111827;">${new Date().toLocaleString()}</td></tr>
        </table>
        <p style="font-size: 12px; color: #6b7280; margin-top: 24px;">您可以打开网页后台的实时日志或控制台对脚本进行干预。</p>
      </div>
    `;

    await this.sendAlertEmail(conn.code, subject, html);
  }

  /**
   * 记录设备账号上线
   */
  private async handleAccountLogin(
    deviceId: string,
    code: string,
    account: string,
  ) {
    try {
      // 1. 防御性检查：如果有未下线的同设备同账号记录，先将其下线
      await this.prisma.deviceAccountHistory.updateMany({
        where: {
          deviceId,
          account,
          logoutTime: null,
        },
        data: {
          logoutTime: new Date(),
        },
      });

      // 2. 插入新的一条
      await this.prisma.deviceAccountHistory.create({
        data: {
          deviceId,
          code,
          account,
          loginTime: new Date(),
        },
      });

      // 3. 自动清理该设备 2 天前的旧账号记录（防止数据库无限增大）
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await this.prisma.deviceAccountHistory.deleteMany({
        where: {
          deviceId,
          createdAt: {
            lt: twoDaysAgo,
          },
        },
      });
    } catch (err) {
      this.logger.error(`handleAccountLogin 数据库写入错误:`, err);
    }
  }

  /**
   * 记录设备账号下线
   */
  private async handleAccountLogout(deviceId: string, account: string) {
    try {
      const latestActive = await this.prisma.deviceAccountHistory.findFirst({
        where: {
          deviceId,
          account,
          logoutTime: null,
        },
        orderBy: {
          loginTime: 'desc',
        },
      });

      if (latestActive) {
        await this.prisma.deviceAccountHistory.update({
          where: { id: latestActive.id },
          data: { logoutTime: new Date() },
        });
      }
    } catch (err) {
      this.logger.error(`handleAccountLogout 数据库写入错误:`, err);
    }
  }

  /**
   * 强制特定设备下线切号
   */
  public forceSwitchAccountDevice(deviceId: string, reason: string) {
    const connection = this.activeConnections.get(deviceId);
    if (connection) {
      this.logger.log(`向设备下发强制换号指令: ${deviceId}, 原因: ${reason}`);

      // 临时标记设备处于换号切换中状态
      if (connection.deviceInfo) {
        connection.deviceInfo.isSwitchingAccount = 1;
        connection.deviceInfo.currentTask = '正在切退当前账号...';
      }

      // 广播设备状态为切号中
      this.deviceState$.next({
        type: 'device_status',
        code: connection.code,
        deviceId,
        payload: {
          ...connection.deviceInfo,
          status: 'online',
          isSwitchingAccount: true,
          currentTask: '正在切退当前账号...',
        },
      });

      connection.socket.write(
        JSON.stringify({
          cmd: 'switch_account',
          message: reason,
        }) + '\n',
      );
    }
  }

  /**
   * 被动防御检测：同一卡密共享时，禁止登录相同的账号
   */
  private async checkAccountSharingConflict(
    connection: ClientConnection,
    account: string,
  ) {
    try {
      // 1. 先查询这个激活码是否开启了防共享排重校验
      const regCode = await this.prisma.registerCode.findUnique({
        where: { code: connection.code },
      });

      if (!regCode) return;

      const codeRecord = regCode as Record<string, any>;
      const config = (codeRecord.alertConfig as Record<string, any>) || {};
      if (!config.preventDuplicateAccount) {
        return; // 未开启防御，直接跳过
      }

      // 2. 检索当前内存中相同 code 下的所有活跃连接
      for (const [
        otherDeviceId,
        otherConn,
      ] of this.activeConnections.entries()) {
        if (
          otherDeviceId !== connection.deviceId &&
          otherConn.code === connection.code
        ) {
          const otherAccount = otherConn.deviceInfo?.currentAccount;
          if (otherAccount && otherAccount.trim() === account.trim()) {
            // 检查对方设备的心跳是否已经过期（超过3分钟未发心跳）
            const lastActive = otherConn.lastActiveTime;
            const now = new Date();
            const timeoutMs = 3 * 60 * 1000;
            if (
              lastActive &&
              now.getTime() - lastActive.getTime() > timeoutMs
            ) {
              this.logger.log(
                `[防重复多开] 检测到设备 [${otherDeviceId}] 的账号 [${account}] 虽然占线，但心跳已过期，不引发冲突，强制回收并继续`,
              );
              try {
                this.forceKickDevice(otherDeviceId);
              } catch (kickErr) {}
              continue;
            }

            // 发现冲突！有两个设备登录了同一个账号。
            this.logger.warn(
              `[防重复多开] 检测到冲突！激活码 [${connection.code}] 下的设备 [${connection.deviceId}] 和设备 [${otherDeviceId}] 同时登录了账号 [${account}]`,
            );

            // 根据配置决定动作
            const action = config.duplicateAction || 'kick_new'; // 默认 kick_new (防御踢新)

            if (action === 'kick_new') {
              // 踢新号：让当前刚刚上报这个账号的设备换号
              this.logger.log(
                `[防重复多开] 策略为踢新：强制新登录设备 [${connection.deviceId}] 换号下线`,
              );
              connection.socket.write(
                JSON.stringify({
                  cmd: 'switch_account',
                  message: `账号 [${account}] 已在其他设备运行，您已被防御换号，请使用下一个账号`,
                }) + '\n',
              );
            } else if (action === 'kick_old') {
              // 踢老号：让之前已经登录这个账号的老设备换号
              this.logger.log(
                `[防重复多开] 策略为踢老：强制原登录设备 [${otherDeviceId}] 换号下线`,
              );
              otherConn.socket.write(
                JSON.stringify({
                  cmd: 'switch_account',
                  message: `账号 [${account}] 已在其他设备登录，您已被强制切号`,
                }) + '\n',
              );
            }
          }
        }
      }
    } catch (err) {
      this.logger.error(`执行防多开排重检查出错:`, err);
    }
  }
}
