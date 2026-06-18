import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SystemSettingService } from './system-setting.service';
import { AdminGuard } from '../debug/admin.guard';

@ApiTags('System Settings 系统设置')
@Controller('system/settings')
export class SystemSettingController {
  constructor(private readonly systemSettingService: SystemSettingService) {}

  @Get('public')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取公开系统配置状态',
    description: '免登录访问，主要供登录页面检测邮件功能是否开启。',
  })
  async getPublicSettings() {
    return this.systemSettingService.getPublicSettings();
  }

  @Get()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取完整系统设置',
    description: '仅限超级管理员角色访问。对于敏感凭证已执行安全遮蔽。',
  })
  async getSettings() {
    return this.systemSettingService.getSettings();
  }

  @Post()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '更新系统配置',
    description: '仅限超级管理员角色访问。',
  })
  async saveSettings(@Body() body: Record<string, string>) {
    return this.systemSettingService.saveSettings(body);
  }
}
