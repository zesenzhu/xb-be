import { Controller, Get, Post, Body, UseGuards, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { AdminGuard } from '../debug/admin.guard';

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

  /**
   * 快速清空历史日志
   */
  @Post('clear-logs')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '一键清理历史日志',
    description: '删除指定天数之前的过期日志记录，降低磁盘和数据库容量压力。'
  })
  async clearLogs(@Body('days') days?: number) {
    return this.dashboardService.clearOldLogs(days || 30);
  }
}
