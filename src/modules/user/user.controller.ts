/**
 * @file: user.controller.ts
 * @description: 用户管理控制层。提供后台管理员对系统用户的 CRUD 以及角色列表获取 API。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { Controller, Get, Post, Put, Delete, Body, Param, Query, HttpStatus, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { UserService } from './user.service';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

@ApiTags('User 用户管理')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * 1. 分页获取用户列表
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '分页获取用户列表', description: '支持通过用户名、昵称或邮箱模糊检索，联表返回所属角色。' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '页码，默认 1' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '每页条数，默认 10' })
  @ApiQuery({ name: 'search', required: false, type: String, description: '模糊搜索内容（用户名/昵称/邮箱）' })
  @ApiResponse({ status: 200, description: '查询成功' })
  async getList(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const limitNum = limit ? Math.max(1, parseInt(limit, 10)) : 10;
    return this.userService.findAll(pageNum, limitNum, search);
  }

  /**
   * 2. 获取可用角色列表 (供新增/编辑下拉框使用)
   */
  @Get('roles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取可分配的角色列表', description: '返回系统内已经存在的所有角色数据，供添加新账号时进行角色选择。' })
  @ApiResponse({ status: 200, description: '查询成功' })
  async getRoles() {
    return this.userService.getRoles();
  }

  /**
   * 3. 创建系统用户
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '创建系统用户', description: '添加一个系统新账号，密码经过 bcrypt 加密存储。' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 400, description: '用户名已存在' })
  async createUser(@Body() body: CreateUserDto) {
    return this.userService.create(body);
  }

  /**
   * 4. 更新系统用户
   */
  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '编辑系统用户', description: '修改系统用户的邮箱、昵称、分配角色或账户启用/禁用状态。' })
  @ApiResponse({ status: 200, description: '修改成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  async updateUser(@Param('id') id: string, @Body() body: UpdateUserDto) {
    return this.userService.update(id, body);
  }

  /**
   * 5. 物理删除系统用户
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '注销/删除用户', description: '物理从数据库中删除指定用户，操作具有高敏感性。' })
  @ApiResponse({ status: 200, description: '删除成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  async deleteUser(@Param('id') id: string) {
    await this.userService.delete(id);
    return { success: true, message: '用户已成功注销删除！' };
  }
}
