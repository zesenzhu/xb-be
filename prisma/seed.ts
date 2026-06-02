/**
 * @file: seed.ts
 * @description: Prisma 数据库初始化播种脚本。一键构建系统默认的 RBAC 角色权限、管理员账户与测试授权激活码。
 * @author: Antigravity AI
 * @date: 2026-06-02
 *
 * [核心职责]
 * 1. 权限定义：在 sys_permission 表中批量注入核心模块细粒度控制权限码；
 * 2. 角色建立：在 sys_role 表中创建 ADMIN (超级管理员), OPERATOR (运营员) 两个核心管理角色；
 * 3. 角色授权：多对多绑定权限关联；
 * 4. 用户开户：创建 admin 账户，密码经过 bcrypt 强哈希（admin123）并关联 ADMIN 角色；
 * 5. 注册码生成：在 register_code 数据库中预置 XB-TEST-888888 与 XB-VIP-999999 两个高可用测试激活码。
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('=== [Prisma Seed] ⚙️ 开始执行数据库初始化种子播种 ===');

  // =========================================================================
  // 1. 播种 sys_permission (系统核心細粒度权限码)
  // =========================================================================
  const permissionsData = [
    // 用户管理模块
    { name: '查询用户列表', code: 'user:list', description: '允许查询管理员与普通用户列表' },
    { name: '创建用户', code: 'user:create', description: '允许在后台创建新账户' },
    { name: '编辑用户', code: 'user:update', description: '允许编辑用户信息与角色分配' },
    { name: '删除用户', code: 'user:delete', description: '允许物理删除账户' },
    
    // 角色权限模块
    { name: '查询角色列表', code: 'role:list', description: '允许查看RBAC角色配置' },
    { name: '配置角色权限', code: 'role:update', description: '允许编辑角色绑定的权限码数组' },

    // 授权码管理模块
    { name: '查询注册码', code: 'regcode:list', description: '允许查询授权激活码的状态' },
    { name: '批量生成注册码', code: 'regcode:create', description: '允许批量生成设备授权激活卡' },
    { name: '编辑注册码限制', code: 'regcode:update', description: '允许禁用激活码、调整QPS流控阈值' },
    { name: '物理删除注册码', code: 'regcode:delete', description: '允许删除激活码数据' },

    // 实时日志大屏模块
    { name: '查看设备日志', code: 'log:list', description: '允许接入实时日志长连接与检索' },
    { name: '监控设备列表', code: 'device:list', description: '允许查看端侧设备在线/离线拓扑' },

    // AI 任务大屏模块
    { name: '调度AI Agent', code: 'ai:config', description: '允许配置 AI 提示词与一键发送自然语言任务指令' }
  ];

  console.log(`[Seed] 正在注入 ${permissionsData.length} 个核心系统权限码...`);
  
  // 利用 upsert 机制保证幂等性，防止重复执行种子时发生主键唯一冲突
  const permissions = [];
  for (const item of permissionsData) {
    const perm = await prisma.permission.upsert({
      where: { code: item.code },
      update: {},
      create: item,
    });
    permissions.push(perm);
  }

  // =========================================================================
  // 2. 播种 sys_role (建立超级管理员与运营员角色，并完成多对多授权)
  // =========================================================================
  console.log('[Seed] 正在初始化 sys_role 角色实体并绑定权限关系...');
  
  // 2.1 超级管理员：分配本系统所有可用的权限码
  const adminRole = await prisma.role.upsert({
    where: { name: '超级管理员' },
    update: {
      permissions: {
        set: permissions.map(p => ({ id: p.id })) // 多对多关联重新设置
      }
    },
    create: {
      name: '超级管理员',
      description: '拥有系统所有管理权限的最高行政账号',
      permissions: {
        connect: permissions.map(p => ({ id: p.id }))
      }
    }
  });

  // 2.2 运营人员：剔除敏感的角色配置和物理删除权限，仅保留 CRUD 业务
  const operatorPermissions = permissions.filter(
    p => !['role:update', 'user:delete', 'regcode:delete'].includes(p.code)
  );

  const operatorRole = await prisma.role.upsert({
    where: { name: '运营人员' },
    update: {
      permissions: {
        set: operatorPermissions.map(p => ({ id: p.id }))
      }
    },
    create: {
      name: '运营人员',
      description: '负责激活码发放、设备自检与AI任务监控的常规运营账号',
      permissions: {
        connect: operatorPermissions.map(p => ({ id: p.id }))
      }
    }
  });

  // =========================================================================
  // 3. 播种 sys_user (创建默认的管理员与测试运营账号，密码 bcrypt 强加密)
  // =========================================================================
  console.log('[Seed] 正在注入默认 sys_user 用户并进行 bcrypt 哈希加密...');
  
  // 生成 bcrypt salt
  const salt = await bcrypt.genSalt(10);
  const adminPasswordHash = await bcrypt.hash('admin123', salt);
  const operatorPasswordHash = await bcrypt.hash('operator123', salt);

  // 3.1 注入超级管理员 admin (密码: admin123)
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: { roleId: adminRole.id },
    create: {
      username: 'admin',
      password: adminPasswordHash,
      nickname: '总控台首席管理员',
      roleId: adminRole.id
    }
  });

  // 3.2 注入普通运营账号 test_op (密码: operator123)
  await prisma.user.upsert({
    where: { username: 'test_op' },
    update: { roleId: operatorRole.id },
    create: {
      username: 'test_op',
      password: operatorPasswordHash,
      nickname: '高级运营专员',
      roleId: operatorRole.id
    }
  });

  // =========================================================================
  // 4. 播种 register_code (物理预置两个高可用的开发联调激活码)
  // =========================================================================
  console.log('[Seed] 正在注入 register_code 极速测试激活码...');
  
  const seedCodes = [
    {
      code: 'XB-TEST-888888',
      maxActive: 3,
      usedNum: 0,
      status: 1, // 正常可用
      allowedApis: ['log:list', 'device:list', 'ai:config'],
      expireTime: new Date('2030-12-31T23:59:59Z')
    },
    {
      code: 'XB-VIP-999999',
      maxActive: 10,
      usedNum: 0,
      status: 1, // 正常可用
      allowedApis: ['*'], // 拥有最高 API 调用特权
      expireTime: new Date('2032-12-31T23:59:59Z')
    }
  ];

  for (const item of seedCodes) {
    await prisma.registerCode.upsert({
      where: { code: item.code },
      update: {
        expireTime: item.expireTime,
        maxActive: item.maxActive,
        allowedApis: item.allowedApis
      },
      create: {
        code: item.code,
        expireTime: item.expireTime,
        maxActive: item.maxActive,
        usedNum: item.usedNum,
        status: item.status,
        bindDevices: '[]',
        allowedApis: item.allowedApis
      }
    });
  }

  console.log('=== [Prisma Seed] ✓ 恭喜！初始化种子数据全数注入成功！ ===');
}

main()
  .catch((e) => {
    console.error('[Prisma Seed] ❌ 播种过程中遇到致命错误: ', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
