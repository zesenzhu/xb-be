/**
 * @file: user.controller.ts
 * @description: 用户管理控制层。提供后台管理员对系统用户的 CRUD 以及角色列表获取 API。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpStatus,
  HttpCode,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Request } from 'express';
import { UserService } from './user.service';
import {
  CreateUserDto,
  UpdateUserDto,
  UpdateRolePermissionsDto,
  UpdateProfileDto,
  UpdatePasswordDto,
} from './dto/user.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user: {
    role: string;
    sub: string;
    username: string;
  };
}

@ApiTags('User 用户管理')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * 1. 分页获取用户列表
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '分页获取用户列表',
    description: '支持通过用户名、昵称或邮箱模糊检索，联表返回所属角色。',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '页码，默认 1',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '每页条数，默认 10',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: '模糊搜索内容（用户名/昵称/邮箱）',
  })
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
  @ApiOperation({
    summary: '获取可分配的角色列表',
    description:
      '返回系统内已经存在的所有角色数据，供添加新账号时进行角色选择。',
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  async getRoles() {
    return this.userService.getRoles();
  }

  /**
   * 3. 创建系统用户
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '创建系统用户',
    description: '添加一个系统新账号，密码经过 bcrypt 加密存储。',
  })
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
  @ApiOperation({
    summary: '编辑系统用户',
    description: '修改系统用户的邮箱、昵称、分配角色或账户启用/禁用状态。',
  })
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
  @ApiOperation({
    summary: '注销/删除用户',
    description: '物理从数据库中删除指定用户，操作具有高敏感性。',
  })
  @ApiResponse({ status: 200, description: '删除成功' })
  @ApiResponse({ status: 404, description: '用户不存在' })
  async deleteUser(@Param('id') id: string) {
    await this.userService.delete(id);
    return { success: true, message: '用户已成功注销删除！' };
  }

  /**
   * 6. 获取所有可用角色及其权限映射详情
   */
  @Get('roles/detail')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取角色详情及其权限码',
    description: '用于角色权限管理控制台加载全量角色及绑定关系。',
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  async getRolesDetail() {
    return this.userService.getRolesWithPermissions();
  }

  /**
   * 7. 保存角色绑定的权限列表
   */
  @Put('roles/:id/permissions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '保存角色的权限配置',
    description: '为指定角色重新覆盖配置其绑定的细粒度系统权限码列表。',
  })
  @ApiResponse({ status: 200, description: '更新成功' })
  async updateRolePermissions(
    @Param('id') id: string,
    @Body() body: UpdateRolePermissionsDto,
  ) {
    return this.userService.updateRolePermissions(id, body.permissionCodes);
  }

  /**
   * 8. 获取当前登录用户的个人中心资料 (包含角色及详细权限码)
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取当前登录用户的资料',
    description:
      '基于 Cookie 或 Auth Header 中的 JWT 令牌自动解析用户 ID，返回包括角色与详细系统权限码的个人基本资料。',
  })
  @ApiResponse({ status: 200, description: '获取成功' })
  async getProfile(@Req() req: AuthenticatedRequest) {
    const userId = req.user.sub;
    return this.userService.getProfile(userId);
  }

  /**
   * 9. 更新当前登录用户的个人资料 (支持昵称、邮箱、头像)
   */
  @Put('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '修改个人资料',
    description: '只允许修改当前登录账号的昵称、邮箱和头像链接，防止越权修改。',
  })
  @ApiResponse({ status: 200, description: '更新成功' })
  async updateProfile(
    @Req() req: AuthenticatedRequest,
    @Body() body: UpdateProfileDto,
  ) {
    const userId = req.user.sub;
    return this.userService.updateProfile(userId, body);
  }

  /**
   * 10. 安全修改当前登录用户的账号密码
   */
  @Put('me/password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '安全修改账户密码',
    description: '需要输入旧密码进行二次校验，校验成功后允许更新为新密码。',
  })
  @ApiResponse({ status: 200, description: '修改成功' })
  @ApiResponse({ status: 400, description: '旧密码校验失败' })
  async updatePassword(
    @Req() req: AuthenticatedRequest,
    @Body() body: UpdatePasswordDto,
  ) {
    const userId = req.user.sub;
    return this.userService.updatePassword(
      userId,
      body.oldPassword,
      body.newPassword,
    );
  }
}
