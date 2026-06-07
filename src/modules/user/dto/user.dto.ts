import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsEmail, IsOptional, MinLength, IsNumber, Min, Max, IsArray } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ description: '登录用户名', example: 'zhangsan' })
  @IsString({ message: '用户名必须是字符串' })
  @IsNotEmpty({ message: '用户名不能为空' })
  username: string;

  @ApiPropertyOptional({ description: '登录密码，如果不填默认 123456', minLength: 6, example: '123456' })
  @IsString({ message: '密码必须是字符串' })
  @IsOptional()
  @MinLength(6, { message: '密码长度不能小于 6 位' })
  password?: string;

  @ApiProperty({ description: '用户昵称', example: '张三' })
  @IsString({ message: '昵称必须是字符串' })
  @IsNotEmpty({ message: '昵称不能为空' })
  nickname: string;

  @ApiProperty({ description: '电子邮箱', example: 'zhangsan@xbnest.com' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  @IsNotEmpty({ message: '邮箱不能为空' })
  email: string;

  @ApiProperty({ description: '系统分配的角色 ID', example: 'uuid-role-id' })
  @IsString({ message: '角色ID必须是字符串' })
  @IsNotEmpty({ message: '角色ID不能为空' })
  roleId: string;

  @ApiPropertyOptional({ description: '头像地址', example: 'https://example.com/avatar.png' })
  @IsString({ message: '头像地址必须是字符串' })
  @IsOptional()
  avatar?: string;

  @ApiPropertyOptional({ description: '账号状态：1-正常激活，0-冻结禁用', enum: [0, 1], example: 1 })
  @IsNumber({}, { message: '状态必须是数字' })
  @IsOptional()
  @Min(0, { message: '状态值不合法' })
  @Max(1, { message: '状态值不合法' })
  status?: number;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ description: '用户昵称', example: '张三改' })
  @IsString({ message: '昵称必须是字符串' })
  @IsOptional()
  nickname?: string;

  @ApiPropertyOptional({ description: '电子邮箱', example: 'zhangsan_new@xbnest.com' })
  @IsEmail({}, { message: '邮箱格式不正确' })
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ description: '系统分配的角色 ID', example: 'uuid-role-id' })
  @IsString({ message: '角色ID必须是字符串' })
  @IsOptional()
  roleId?: string;

  @ApiPropertyOptional({ description: '账号状态：1-正常激活，0-冻结禁用', enum: [0, 1], example: 1 })
  @IsNumber({}, { message: '状态必须是数字' })
  @IsOptional()
  @Min(0, { message: '状态值不合法' })
  @Max(1, { message: '状态值不合法' })
  status?: number;

  @ApiPropertyOptional({ description: '重置密码，如果不填则不修改密码', minLength: 6, example: 'new_pwd_123' })
  @IsString({ message: '密码必须是字符串' })
  @IsOptional()
  @MinLength(6, { message: '密码长度不能小于 6 位' })
  password?: string;
}

export class UpdateRolePermissionsDto {
  @ApiProperty({ description: '要绑定的权限 code 列表', example: ['user:list', 'code:list'] })
  @IsArray({ message: '权限列表必须是数组' })
  @IsString({ each: true, message: '权限 code 必须是字符串' })
  permissionCodes: string[];
}
