/**
 * @file: UserEntityWithJSDoc.ts
 * @description: 用户实体模型，包含完整的 JSDoc 与字段物理防冲突注释。
 * @author: Antigravity AI
 * @date: 2026-06-02
 */

import { Role } from '@prisma/client';

/**
 * 系统核心用户实体类。
 * 对应 PostgreSQL 数据库的 User 物理表，主要记录管理员与普通用户的登录与鉴权关联。
 */
export class UserEntity {
  /**
   * 用户唯一物理标识，采用 UUID v4 自动生成。
   * @example 'a25b1c9e-fe86-4c9e-9dc4-bd4e6bd29e66'
   */
  id: string;

  /**
   * 登录用户名，系统内必须全局唯一。
   * 用于作为 JWT 签发的核心载荷字段之一。
   */
  username: string;

  /**
   * 经过 bcrypt 哈希算法加密后的密码密文。
   * ⚠️ 安全警报：在任何 Controller 接口的 Response 序列化中，**必须**将此字段进行物理排队隔离或通过 `@Exclude()` 过滤，严禁明文返回给客户端！
   */
  passwordHash: string;

  /**
   * 用户昵称，支持非空个性化展示，可选字段。
   */
  nickname?: string;

  /**
   * 用户绑定的角色物理外键 ID。
   * 指向 Role 表的主键 UUID。
   */
  roleId: string;

  /**
   * 角色实体对象，描述该用户所拥有的 RBAC 细粒度权限码数组 (Permissions)。
   * 在使用 Prisma 查询时，可通过 `include: { role: true }` 进行联表预加载。
   */
  role: Role;

  /**
   * 账户首次注册并写入数据库的物理时间。
   */
  createdAt: Date;

  /**
   * 账户最近一次被编辑修改的更新时间。
   */
  updatedAt: Date;

  /**
   * 验证该用户是否拥有指定的 RBAC 细粒度操作权限。
   * 
   * @param permission 待验证的权限码（如 'user:delete', 'code:create'）
   * @returns boolean 若拥有该权限返回 true，否则返回 false
   * 
   * @example
   * ```ts
   * const isAllowed = user.hasPermission('user:delete');
   * if (!isAllowed) throw new ForbiddenException('您无权执行此物理删除操作！');
   * ```
   */
  hasPermission(permission: string): boolean {
    // 1. 防御性校检：若用户未绑定角色，或角色没有任何权限定义，直接物理拦截返回 false
    if (!this.role || !this.role.permissions) {
      return false;
    }

    // 2. 超级管理员特权：如果角色权限列表包含 '*' 通配符，直接放行，无需进行逐一字符串比对
    if (this.role.permissions.includes('*')) {
      return true;
    }

    // 3. 严格比对：检验请求的权限码是否完全存在于角色所分配的权限数组中
    return this.role.permissions.includes(permission);
  }
}
