/**
 * @file: admin-login.dto.ts
 * @description: 管理员端账号密码登录数据传输对象。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

export class AdminLoginDto {
  @ApiProperty({
    description: '管理员用户名或注册邮箱',
    example: 'admin',
    required: true,
  })
  @IsNotEmpty({ message: '用户名或邮箱不能为空' })
  @IsString({ message: '用户名或邮箱必须为字符串' })
  @Length(2, 100, { message: '用户名或邮箱长度需在 2 到 100 位之间' })
  username: string;

  @ApiProperty({
    description: '登录密码',
    example: 'admin123',
    required: true,
  })
  @IsNotEmpty({ message: '密码不能为空' })
  @IsString({ message: '密码必须为字符串' })
  @Length(6, 30, { message: '密码长度需在 6 到 30 位之间' })
  password: string;
}
