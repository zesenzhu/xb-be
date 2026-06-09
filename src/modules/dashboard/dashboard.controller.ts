import { Controller, Get, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';

@ApiTags('Dashboard 控制面板')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /**
   * 获取控制面板数据概览
   */
  @Get('overview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取控制面板大屏监控指标',
    description: '聚合系统用户总数、激活卡数量、TCP 在线设备、历史脚本日志报错趋势、AI Token 消耗以及最新诊断报告。'
  })
  @ApiResponse({ status: 200, description: '成功拉取指标数据' })
  async getOverview() {
    return this.dashboardService.getOverview();
  }
}
