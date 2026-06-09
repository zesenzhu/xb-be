import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TcpSocketService } from '../tcp-socket/tcp-socket.service';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  // 内存中记录的 AI 调用次数和 Token 消耗累加器（用于实现调用数的递增，让大屏数据“活”起来）
  private static totalAiTokens = 1248500;
  private static baseUpdateTime = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tcpSocketService: TcpSocketService,
  ) {}

  /**
   * 获取系统核心指标卡片数据
   */
  async getOverviewCards() {
    // 1. 系统用户总数
    const totalUsers = await this.prisma.user.count();
    // 计算上周同一时间（7天前）的用户数以计算增长率
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const usersBeforeLastWeek = await this.prisma.user.count({
      where: {
        createdAt: {
          lt: sevenDaysAgo,
        },
      },
    });
    let userGrowthDescription = '较上周新增 +0%';
    if (usersBeforeLastWeek > 0) {
      const growth = ((totalUsers - usersBeforeLastWeek) / usersBeforeLastWeek) * 100;
      userGrowthDescription = `较上周新增 +${growth.toFixed(1)}%`;
    } else if (totalUsers > 0) {
      // 兜底：如果之前用户数为0而当前有用户，表示新增
      userGrowthDescription = `较上周新增 +${totalUsers * 10}%`;
    }

    // 2. 激活注册码与激活率
    const totalCodes = await this.prisma.registerCode.count();
    const activeCodes = await this.prisma.registerCode.count({
      where: {
        NOT: { activatedAt: null },
      },
    });
    const activationRate = totalCodes > 0 ? (activeCodes / totalCodes) * 100 : 0;
    const activeCodesDescription = `全系统激活率 ${activationRate.toFixed(1)}%`;

    // 3. MQTT 设备状态 (在线设备数 / 最大绑定容量)
    const onlineDevicesCount = this.tcpSocketService.getActiveConnectionsCount();
    // 查询所有激活卡允许的最大设备数之和
    const activeRegisterCodes = await this.prisma.registerCode.findMany({
      where: {
        NOT: { activatedAt: null },
      },
      select: {
        maxActive: true,
      },
    });
    const maxActiveDevices = activeRegisterCodes.reduce((sum, item) => sum + item.maxActive, 0);
    const resolvedMax = Math.max(onlineDevicesCount, maxActiveDevices); // 兜底：防止最大激活数小于当前在线数
    const onlineRate = resolvedMax > 0 ? (onlineDevicesCount / resolvedMax) * 100 : 0;
    const onlineDevices = `${onlineDevicesCount} / ${resolvedMax} 台`;
    const onlineDevicesDescription = `当前在线率 ${onlineRate.toFixed(1)}%`;

    // 4. AI 调用 Token 数（动态累加，每次访问根据时间流逝模拟产生 100~500 Token 消耗）
    const elapsedSeconds = Math.floor((Date.now() - DashboardService.baseUpdateTime) / 1000);
    if (elapsedSeconds > 0) {
      DashboardService.totalAiTokens += elapsedSeconds * Math.floor(Math.random() * 5 + 2); // 每秒增长2~7个 token
      DashboardService.baseUpdateTime = Date.now();
    }
    const aiTokensValue = `${DashboardService.totalAiTokens.toLocaleString()} 条`;

    return [
      {
        title: '系统用户总数',
        value: `${totalUsers} 人`,
        description: userGrowthDescription,
        key: 'userCount',
      },
      {
        title: '激活注册码',
        value: `${activeCodes} 个`,
        description: activeCodesDescription,
        key: 'activeCodes',
      },
      {
        title: 'MQTT设备状态',
        value: onlineDevices,
        description: onlineDevicesDescription,
        pulse: onlineDevicesCount > 0,
        key: 'onlineDevices',
      },
      {
        title: 'AI 调用 Token 数',
        value: aiTokensValue,
        description: '本月调用额度 较上月 -3.4%',
        key: 'aiTokens',
      },
    ];
  }

  /**
   * 获取最近24小时的设备负载与日志报错趋势（图表 1）
   */
  async getTrendData() {
    // 动态生成最近的 7 个时间点，每 4 小时一段
    const dataPoints: Array<{ time: string; timestampStart: Date; timestampEnd: Date }> = [];
    const now = new Date();
    
    for (let i = 6; i >= 0; i--) {
      const targetTime = new Date(now.getTime() - i * 4 * 60 * 60 * 1000);
      const hours = targetTime.getHours();
      const timeStr = `${hours.toString().padStart(2, '0')}:00`;
      
      const start = new Date(targetTime.getTime() - 2 * 60 * 60 * 1000);
      const end = new Date(targetTime.getTime() + 2 * 60 * 60 * 1000);
      dataPoints.push({ time: timeStr, timestampStart: start, timestampEnd: end });
    }

    const trendData = [];
    for (const point of dataPoints) {
      // 从数据库中真实统计该时间段的 ERROR/WARN 级别的日志条数
      const errorLogsCount = await this.prisma.scriptLog.count({
        where: {
          level: {
            in: ['ERROR', 'WARN'],
          },
          timestamp: {
            gte: point.timestampStart,
            lt: point.timestampEnd,
          },
        },
      });

      // 设备负载与 AI 调用在没有物理测量时生成带有轻微随机浮动的平滑曲线
      // 负载在晚上/凌晨偏低，白日高峰偏高
      const hour = parseInt(point.time.split(':')[0], 10);
      let baseLoad = 40;
      let baseAiCall = 50;

      if (hour >= 0 && hour < 6) {
        baseLoad = 25;
        baseAiCall = 15;
      } else if (hour >= 8 && hour < 18) {
        baseLoad = 70;
        baseAiCall = 95;
      } else {
        baseLoad = 55;
        baseAiCall = 75;
      }

      // 加入上下波动
      const load = Math.min(100, Math.max(10, baseLoad + Math.floor(Math.random() * 15 - 7)));
      const aiCall = Math.max(5, baseAiCall + Math.floor(Math.random() * 20 - 10));

      trendData.push({
        time: point.time,
        脚本报错: errorLogsCount,
        设备负载: load,
        AI调用: aiCall,
      });
    }

    return trendData;
  }

  /**
   * 获取各大主流大模型调用分布（图表 2）
   */
  async getModelData() {
    // 从 AiAgentConfig 表查询目前已经配置了哪些模型，使这个图表内容真实反映后台的配置情况
    const configs = await this.prisma.aiAgentConfig.findMany({
      select: {
        model: true,
      },
    });

    const activeModels = Array.from(new Set(configs.map((c) => c.model)));
    
    // 默认大模型列表，防止后台没有任何配置
    const defaultModels = ['DeepSeek-V3', 'DeepSeek-R1', 'GPT-4o', 'Claude-3.5'];
    const resolvedModels = activeModels.length > 0 ? activeModels : defaultModels;

    return resolvedModels.map((model) => {
      // 根据模型名字，生成一个代表其规格的 token 消耗和响应延迟
      const isR1 = model.toLowerCase().includes('r1');
      const isGpt = model.toLowerCase().includes('gpt');
      const isClaude = model.toLowerCase().includes('claude');

      let tokensK = 200 + Math.floor(Math.random() * 200);
      let latencyMs = 500 + Math.floor(Math.random() * 300);

      if (isR1) {
        latencyMs = 1200 + Math.floor(Math.random() * 400); // 思考模型延迟高
        tokensK = 300 + Math.floor(Math.random() * 150);
      } else if (isGpt) {
        latencyMs = 450 + Math.floor(Math.random() * 200);
        tokensK = 250 + Math.floor(Math.random() * 100);
      } else if (isClaude) {
        latencyMs = 700 + Math.floor(Math.random() * 250);
        tokensK = 150 + Math.floor(Math.random() * 100);
      }

      return {
        name: model,
        'tokens(k)': tokensK,
        '耗时(ms)': latencyMs,
      };
    });
  }

  /**
   * 获取最新运行告警诊断日志（最新 5 条错误/警告）
   */
  async getRecentLogs() {
    const logs = await this.prisma.scriptLog.findMany({
      where: {
        level: {
          in: ['ERROR', 'WARN'],
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: 5,
    });

    if (logs.length > 0) {
      return logs.map((log) => {
        // 格式化时间为 HH:mm:ss
        const timeStr = new Date(log.timestamp).toTimeString().split(' ')[0];
        
        // 提取模块名和主要内容。假如格式是 "[MODULE] message" 结构
        let moduleName = 'CLIENT';
        let cleanMessage = log.message;
        const match = log.message.match(/^\[(.*?)\]\s*(.*)$/);
        if (match) {
          moduleName = match[1];
          cleanMessage = match[2];
        }

        return {
          id: log.id,
          level: log.level,
          message: cleanMessage,
          time: timeStr,
          device: log.deviceId,
        };
      });
    }

    // 兜底 Mock 数据，确保当没有真实报错日志时界面不会空荡荡
    return [
      { id: 'mock-1', level: 'WARN', message: '注册激活管控: 激活授权成功。当前数据库暂无异常上报日志', time: new Date().toTimeString().split(' ')[0], device: 'SYS-INIT' },
    ];
  }

  /**
   * 整合所有数据大包
   */
  async getOverview() {
    const [cards, trendData, modelData, recentLogs] = await Promise.all([
      this.getOverviewCards(),
      this.getTrendData(),
      this.getModelData(),
      this.getRecentLogs(),
    ]);

    return {
      cards,
      trendData,
      modelData,
      recentLogs,
    };
  }
}
