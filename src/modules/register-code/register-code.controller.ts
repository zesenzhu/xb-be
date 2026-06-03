/**
 * @file: register-code.controller.ts
 * @description: 注册激活码控制层。提供后台管理员对设备注册码的查询、批量生成与状态管理接口。
 * @author: Antigravity AI
 * @date: 2026-06-03
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
  @ApiOperation({ summary: '批量生成激活码', description: '在数据库中自动批量随机生成以 SEC- 开头的授权激活码。' })
  @ApiResponse({ status: 201, description: '批量生成成功' })
  async generateCodes(@Body() body: any) {
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
   * 4. 物理删除/作废回收激活码
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '作废/回收激活码', description: '物理从系统中废除并删除该注册码，其绑定的设备将立刻丢失授权。' })
  @ApiResponse({ status: 200, description: '删除作废成功' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async deleteCode(@Param('id') id: string) {
    await this.registerCodeService.delete(id);
    return { success: true, message: '该激活码已成功作废并回收！' };
  }
}
