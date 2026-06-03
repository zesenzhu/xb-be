/**
 * @file: user.service.ts
 * @description: 用户模块业务逻辑层。负责用户信息的增删改查与角色权限关联分析。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

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
}
