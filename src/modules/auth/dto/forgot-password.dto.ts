import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SendForgotPasswordCodeDto {
  @ApiProperty({ example: 'admin@xbnest.com', description: '注册邮箱' })
  @IsEmail({}, { message: '请输入正确的邮箱格式' })
  @IsNotEmpty({ message: '邮箱不能为空' })
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ example: 'admin@xbnest.com', description: '注册邮箱' })
  @IsEmail({}, { message: '请输入正确的邮箱格式' })
  @IsNotEmpty({ message: '邮箱不能为空' })
  email: string;

  @ApiProperty({ example: '123456', description: '6位数字验证码' })
  @IsString({ message: '验证码必须为字符串' })
  @IsNotEmpty({ message: '验证码不能为空' })
  @MinLength(6, { message: '验证码至少为 6 位' })
  code: string;

  @ApiProperty({ example: 'newSecurePassword123', description: '新密码' })
  @IsString({ message: '新密码必须为字符串' })
  @IsNotEmpty({ message: '新密码不能为空' })
  @MinLength(6, { message: '新密码长度至少为 6 位' })
  newPassword: string;
}
