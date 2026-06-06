/**
 * @file: register-code.controller.ts
 * @description: 注册激活码控制层。提供后台管理员对设备注册码的查询、按规则批量制卡、时长微调与设备物理解绑。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import { Controller, Get, Post, Patch, Delete, Body, Param, Query, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { RegisterCodeService } from './register-code.service';

@ApiTags('RegisterCode 注册码管理')
@Controller('register-codes')
export class RegisterCodeController {
  constructor(private readonly registerCodeService: RegisterCodeService) {}

  /**
   * 1. 分页获取激活码列表
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '分页获取激活注册码列表', description: '支持通过激活码文本模糊查询。' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '页码，默认 1' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '每页条数，默认 10' })
  @ApiQuery({ name: 'code', required: false, type: String, description: '激活码模糊过滤' })
  @ApiResponse({ status: 200, description: '查询成功' })
  async getList(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('code') code?: string,
  ) {
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const limitNum = limit ? Math.max(1, parseInt(limit, 10)) : 10;
    return this.registerCodeService.findAll(pageNum, limitNum, code);
  }

  /**
   * 2. 批量自动生成授权激活码
   */
  @Post('generate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '批量生成激活码', description: '在数据库中自动批量随机生成以卡种为前缀的授权激活码。' })
  @ApiResponse({ status: 201, description: '批量生成成功' })
  async generateCodes(
    @Body() body: {
      count: number;
      maxActivations: number;
      appName?: string;
      cardType: string;
      durationMinutes: number;
      remark?: string;
    }
  ) {
    return this.registerCodeService.generate(body);
  }

  /**
   * 3. 快捷更新激活码启用/禁用状态
   */
  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '更新注册码启用状态', description: '手动启用或禁用一个注册激活码。' })
  @ApiResponse({ status: 200, description: '状态修改成功' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: 'active' | 'disabled' },
  ) {
    await this.registerCodeService.updateStatus(id, body.status);
    return { success: true, message: '激活码状态更新成功！' };
  }

  /**
   * 4. 剩余使用时长微调接口（方案一）
   */
  @Patch(':id/adjust-time')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '调整激活码剩余有效时间', description: '支持正负数，加减激活码的截止日期，并记录原因' })
  @ApiResponse({ status: 200, description: '微调时间成功' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async adjustTime(
    @Param('id') id: string,
    @Body() body: { adjustMinutes: number; reason: string },
  ) {
    const updated = await this.registerCodeService.adjustDuration(id, body.adjustMinutes, body.reason);
    return {
      success: true,
      message: `已成功微调时长 ${body.adjustMinutes} 分钟！`,
      data: {
        expireTime: updated.expireTime,
        remark: updated.remark,
      }
    };
  }

  /**
   * 5. 强行解绑当前注册码上的全部设备
   */
  @Patch(':id/unbind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '强行解绑该卡所有设备', description: '清空已绑定设备，重置usedNum，断开其长连接' })
  @ApiResponse({ status: 200, description: '解绑成功' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async unbindDevices(@Param('id') id: string) {
    const updated = await this.registerCodeService.unbindDevice(id);
    return {
      success: true,
      message: '该注册码已成功清除所有设备绑定！',
      data: {
        usedNum: updated.usedNum,
        bindDevices: updated.bindDevices,
      }
    };
  }

  /**
   * 6. 物理删除/作废回收激活码
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '作废/回收激活码', description: '物理从系统中废除并删除该注册码，其绑定的设备将立刻丢失授权并踢下线。' })
  @ApiResponse({ status: 200, description: '删除作废成功' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async deleteCode(@Param('id') id: string) {
    await this.registerCodeService.delete(id);
    return { success: true, message: '该激活码已成功作废并回收！' };
  }
}
