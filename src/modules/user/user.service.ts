/**
 * @file: user.service.ts
 * @description: 用户模块业务逻辑层。负责用户信息的增删改查与角色权限关联分析。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
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
    return this.prisma.user.findUnique({
      where: { username },
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
      (key) => cleanUpdateData[key] === undefined && delete cleanUpdateData[key],
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
}
