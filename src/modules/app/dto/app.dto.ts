import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsInt, IsIn } from 'class-validator';

export class CreateAppDto {
  @ApiProperty({ description: '应用名称', example: '天龙八部手游脚本' })
  @IsString()
  @IsNotEmpty({ message: '应用名称不能为空' })
  name: string;

  @ApiProperty({ description: '唯一标识', example: 'game_tlbb' })
  @IsString()
  @IsNotEmpty({ message: '应用标识 appKey 不能为空' })
  appKey: string;

  @ApiPropertyOptional({ description: '应用描述', example: '主要包含野外挂机和自动任务' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: '状态：1-启用，0-禁用', example: 1 })
  @IsInt()
  @IsIn([0, 1])
  @IsOptional()
  status?: number;

  @ApiPropertyOptional({ description: '跳转大屏界面/路由', example: '/user/apps/frxxzrjp' })
  @IsString()
  @IsOptional()
  dashboardPath?: string;
}

export class UpdateAppDto {
  @ApiPropertyOptional({ description: '应用名称' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: '唯一标识' })
  @IsString()
  @IsOptional()
  appKey?: string;

  @ApiPropertyOptional({ description: '应用描述' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: '状态：1-启用，0-禁用' })
  @IsInt()
  @IsIn([0, 1])
  @IsOptional()
  status?: number;

  @ApiPropertyOptional({ description: '跳转大屏界面/路由' })
  @IsString()
  @IsOptional()
  dashboardPath?: string;
}

export class CreateAppFeatureDto {
  @ApiProperty({ description: '功能名称', example: '自动主线' })
  @IsString()
  @IsNotEmpty({ message: '功能名称不能为空' })
  name: string;

  @ApiProperty({ description: '功能标识', example: 'auto_main' })
  @IsString()
  @IsNotEmpty({ message: '功能标识 code 不能为空' })
  code: string;

  @ApiPropertyOptional({ description: '功能描述', example: '自动运行主线任务' })
  @IsString()
  @IsOptional()
  description?: string;
}

export class UpdateAppFeatureDto {
  @ApiPropertyOptional({ description: '功能名称' })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: '功能标识' })
  @IsString()
  @IsOptional()
  code?: string;

  @ApiPropertyOptional({ description: '功能描述' })
  @IsString()
  @IsOptional()
  description?: string;
}
