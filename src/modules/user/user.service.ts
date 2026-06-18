/**
 * @file: user.service.ts
 * @description: 用户模块业务逻辑层。负责用户信息的增删改查与角色权限关联分析。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 根据用户名联表查询用户详情，并附带角色及角色所拥有的权限码
   *
   * @param username 登录用户名
   * @returns 用户信息、角色及其关联权限
   */
  async findByUsername(username: string) {
    return this.prisma.user.findFirst({
      where: {
        OR: [{ username }, { email: username }],
      },
      include: {
        role: {
          include: {
            permissions: true,
          },
        },
      },
    });
  }

  /**
   * 校验明文密码与 bcrypt 哈希密码是否匹配
   *
   * @param password 明文密码
   * @param hash 数据库哈希密文
   * @returns boolean 是否匹配
   */
  async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * 分页获取用户列表并模糊检索
   */
  async findAll(page: number, limit: number, search?: string) {
    const skip = (page - 1) * limit;
    const where: Prisma.UserWhereInput = {};

    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { nickname: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [list, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          role: {
            select: {
              id: true,
              name: true,
              description: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    // 移除敏感的密码数据后返回
    const safeList = list.map(({ password, ...user }) => user);

    return { list: safeList, total };
  }

  /**
   * 创建系统新用户
   */
  async create(data: CreateUserDto) {
    const existing = await this.prisma.user.findUnique({
      where: { username: data.username },
    });

    if (existing) {
      throw new BadRequestException('该用户名已存在，请换一个用户名！');
    }

    // 哈希加密密码 (默认为 123456 如果前端未传)
    const rawPassword = data.password || '123456';
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    return this.prisma.user.create({
      data: {
        username: data.username,
        password: hashedPassword,
        nickname: data.nickname,
        email: data.email || null,
        avatar: data.avatar || null,
        status: data.status !== undefined ? Number(data.status) : 1,
        roleId: data.roleId,
      },
      include: {
        role: true,
      },
    });
  }

  /**
   * 更新用户信息
   */
  async update(id: string, data: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('该用户不存在！');
    }

    const updateData: Prisma.UserUncheckedUpdateInput = {
      nickname: data.nickname,
      email: data.email,
      roleId: data.roleId,
      status: data.status !== undefined ? Number(data.status) : undefined,
    };

    // 如果更新中包含新密码，则哈希加密
    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, 10);
    }

    // 去除 undefined 的项
    const cleanUpdateData = updateData as Record<string, any>;
    Object.keys(cleanUpdateData).forEach(
      (key) =>
        cleanUpdateData[key] === undefined && delete cleanUpdateData[key],
    );

    return this.prisma.user.update({
      where: { id },
      data: updateData,
      include: {
        role: true,
      },
    });
  }

  /**
   * 物理删除用户
   */
  async delete(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException('该用户不存在！');
    }

    return this.prisma.user.delete({
      where: { id },
    });
  }

  /**
   * 获取所有系统可用角色列表
   */
  async getRoles() {
    return this.prisma.role.findMany({
      select: {
        id: true,
        name: true,
        description: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  /**
   * 获取所有系统可用角色列表（带关联权限详情）
   */
  async getRolesWithPermissions() {
    const roles = await this.prisma.role.findMany({
      include: {
        permissions: {
          select: {
            code: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    // 格式化输出为前端期待的 RoleItem 结构（将 permissions 扁平化为 string[]）
    return roles.map((role) => ({
      id: role.id,
      name: role.name,
      code:
        role.name === '超级管理员'
          ? 'admin'
          : role.name === '运营人员'
            ? 'operator'
            : 'tester', // 映射 role.code
      description: role.description || '',
      permissions: role.permissions.map((p) => p.code),
    }));
  }

  /**
   * 更新特定角色的权限绑定 (Prisma 多对多关系物理覆盖)
   */
  async updateRolePermissions(roleId: string, permissionCodes: string[]) {
    // 1. 查询这些权限 Code 对应的权限实体
    const permissions = await this.prisma.permission.findMany({
      where: {
        code: { in: permissionCodes },
      },
    });

    // 2. 物理重设多对多关联
    return this.prisma.role.update({
      where: { id: roleId },
      data: {
        permissions: {
          set: permissions.map((p) => ({ id: p.id })),
        },
      },
      include: {
        permissions: true,
      },
    });
  }

  /**
   * 8. 获取当前登录用户的 Profile 详情 (含角色权限码)
   */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        role: {
          include: {
            permissions: {
              select: {
                code: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('当前登录用户不存在');
    }

    const safeUser = { ...user };
    safeUser.password = ''; // 置空防泄露且避开未定义警告
    const permissions = user.role?.permissions.map((p) => p.code) || [];

    return {
      ...safeUser,
      permissions,
    };
  }

  /**
   * 9. 更新用户基本资料 (昵称, 邮箱, 头像)
   */
  async updateProfile(
    userId: string,
    data: { nickname?: string; email?: string; avatar?: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('当前登录用户不存在');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        nickname: data.nickname,
        email: data.email,
        avatar: data.avatar,
      },
      include: {
        role: true,
      },
    });

    const safeUser = { ...updated };
    safeUser.password = ''; // 置空防泄露
    return safeUser;
  }

  /**
   * 10. 修改用户账户密码 (需要旧密码二次安全验证)
   */
  async updatePassword(userId: string, oldPass: string, newPass: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('当前登录用户不存在');
    }

    const isMatch = await this.comparePassword(oldPass, user.password);
    if (!isMatch) {
      throw new BadRequestException('您的旧密码验证失败，请重新确认！');
    }

    const hashed = await bcrypt.hash(newPass, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashed,
      },
    });

    return {
      success: true,
      message: '您的账户密码已修改成功，请妥善保管！',
    };
  }
}
