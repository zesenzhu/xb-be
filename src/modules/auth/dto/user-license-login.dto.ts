/**
 * @file: user-license-login.dto.ts
 * @description: 用户端注册码极速登录数据传输对象。
 * @author: Antigravity AI
 * @date: 2026-06-03
 */

import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Length } from 'class-validator';

export class UserLicenseLoginDto {
  @ApiProperty({
    description: '注册激活码 (License Code)',
    example: 'XB-TEST-888888',
    required: true,
  })
  @IsNotEmpty({ message: '注册激活码不能为空' })
  @IsString({ message: '注册激活码必须为字符串' })
  @Length(6, 50, { message: '注册激活码长度不合法' })
  code: string;

  @ApiProperty({
    description:
      '客户端物理设备唯一标识符 (可选，若不传后端将基于 User-Agent 和 IP 自动指纹指派)',
    example: 'DEVICE-MAC-001122334455',
    required: false,
  })
  @IsOptional()
  @IsString({ message: '设备 ID 必须为字符串' })
  deviceId?: string;
}
