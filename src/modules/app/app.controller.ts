import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AppService } from './app.service';
import { AdminGuard } from '../debug/admin.guard';
import {
  CreateAppDto,
  UpdateAppDto,
  CreateAppFeatureDto,
  UpdateAppFeatureDto,
} from './dto/app.dto';

@ApiTags('App Management 应用管理')
@Controller('apps')
export class AppController {
  constructor(private readonly appService: AppService) {}

  // ==========================================
  // App API
  // ==========================================

  @Post()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '创建新应用/游戏脚本项目' })
  @ApiResponse({ status: 201, description: '创建成功' })
  @ApiResponse({ status: 400, description: '唯一键冲突或参数错误' })
  async createApp(@Body() dto: CreateAppDto) {
    return this.appService.createApp(dto);
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取所有应用列表(包含功能点)' })
  async findAllApps() {
    return this.appService.findAllApps();
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取单个应用详情' })
  async findOneApp(@Param('id') id: string) {
    return this.appService.findOneApp(id);
  }

  @Put(':id')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '更新应用信息' })
  async updateApp(@Param('id') id: string, @Body() dto: UpdateAppDto) {
    return this.appService.updateApp(id, dto);
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除应用项目' })
  async removeApp(@Param('id') id: string) {
    return this.appService.removeApp(id);
  }

  // ==========================================
  // AppFeature API
  // ==========================================

  @Post(':appId/features')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '为特定应用创建功能权限点' })
  async createFeature(
    @Param('appId') appId: string,
    @Body() dto: CreateAppFeatureDto,
  ) {
    return this.appService.createFeature(appId, dto);
  }

  @Get(':appId/features')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取特定应用下的所有功能权限点' })
  async findFeaturesByApp(@Param('appId') appId: string) {
    return this.appService.findFeaturesByApp(appId);
  }

  @Put('features/:featureId')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '更新指定功能点信息' })
  async updateFeature(
    @Param('featureId') featureId: string,
    @Body() dto: UpdateAppFeatureDto,
  ) {
    return this.appService.updateFeature(featureId, dto);
  }

  @Delete('features/:featureId')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '删除指定功能权限点' })
  async removeFeature(@Param('featureId') featureId: string) {
    return this.appService.removeFeature(featureId);
  }
}
