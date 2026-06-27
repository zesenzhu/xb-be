import {
  Controller,
  Post,
  HttpCode,
  HttpStatus,
  UseGuards,
  Body,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { DebugService } from './debug.service';
import { AdminGuard } from './admin.guard';

@ApiTags('Debug 物理调试沙箱')
@Controller('debug')
@UseGuards(AdminGuard)
export class DebugController {
  constructor(private readonly debugService: DebugService) {}

  @Post('create-temp-code')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '快速创建测试卡密',
    description: '一键生成 XB-DEBUG- 前缀卡密，供全链路调试测试。',
  })
  @ApiResponse({ status: 201, description: '创建成功' })
  async createTempCode() {
    return this.debugService.createTempCode();
  }

  @Post('cleanup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '清理全部测试卡密及设备数据',
    description:
      '一键物理清除系统内所有 XB-DEBUG- 前缀的卡密与设备物理绑定，防止脏数据堆积。',
  })
  @ApiResponse({ status: 200, description: '清理成功' })
  async cleanup() {
    return this.debugService.cleanup();
  }

  @Post('test-push')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '发送测试桌面推送通知',
    description:
      '向指定卡密（需已在用户端开启桌面通知）发送一条自定义测试推送消息。',
  })
  @ApiResponse({ status: 200, description: '发送测试推送完成' })
  async sendTestPush(
    @Body()
    body: {
      code: string;
      title?: string;
      body?: string;
    },
  ) {
    return this.debugService.sendTestPush(body.code, body.title, body.body);
  }
}
