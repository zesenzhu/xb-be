/**
 * @file: register-code.controller.ts
 * @description: 注册激活码控制层。提供后台管理员对设备注册码的查询、按规则批量制卡、时长微调与设备物理解绑。
 * @author: Antigravity AI
 * @date: 2026-06-06
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpStatus,
  HttpCode,
  BadRequestException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { RegisterCodeService } from './register-code.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsNotEmpty, IsString, IsOptional, IsObject } from 'class-validator';

export class VerifyRegisterCodeDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  deviceId: string;
}

export class UpdateMyAlertDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsOptional()
  alertEmail?: string;

  @IsObject()
  @IsOptional()
  alertConfig?: any;
}

@ApiTags('RegisterCode 注册码管理')
@Controller('register-codes')
export class RegisterCodeController {
  constructor(private readonly registerCodeService: RegisterCodeService) {}

  /**
   * 1. 分页获取激活码列表
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '分页获取激活注册码列表',
    description: '支持通过激活码、应用名、卡种、设备ID、状态及过期时间过滤。',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '页码，默认 1',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '每页条数，默认 10',
  })
  @ApiQuery({
    name: 'code',
    required: false,
    type: String,
    description: '激活码模糊过滤',
  })
  @ApiQuery({
    name: 'appName',
    required: false,
    type: String,
    description: '应用名称过滤，general 表示通用型',
  })
  @ApiQuery({
    name: 'cardType',
    required: false,
    type: String,
    description: '卡种类型过滤',
  })
  @ApiQuery({
    name: 'deviceId',
    required: false,
    type: String,
    description: '绑定物理设备ID过滤',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    type: String,
    description: '激活码状态',
  })
  @ApiQuery({
    name: 'isEnabled',
    required: false,
    type: String,
    description: '是否启用 (true/false)',
  })
  @ApiQuery({
    name: 'source',
    required: false,
    type: String,
    description: '激活码来源 (CREATE/IMPORT)',
  })
  @ApiQuery({
    name: 'expireStart',
    required: false,
    type: String,
    description: '到期时间起',
  })
  @ApiQuery({
    name: 'expireEnd',
    required: false,
    type: String,
    description: '到期时间止',
  })
  @ApiResponse({ status: 200, description: '查询成功' })
  async getList(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('code') code?: string,
    @Query('appName') appName?: string,
    @Query('cardType') cardType?: string,
    @Query('deviceId') deviceId?: string,
    @Query('status') status?: string,
    @Query('isEnabled') isEnabled?: string,
    @Query('source') source?: string,
    @Query('expireStart') expireStart?: string,
    @Query('expireEnd') expireEnd?: string,
  ): Promise<any> {
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const limitNum = limit ? Math.max(1, parseInt(limit, 10)) : 10;

    let isEnabledBool: boolean | undefined;
    if (isEnabled === 'true') isEnabledBool = true;
    if (isEnabled === 'false') isEnabledBool = false;

    return this.registerCodeService.findAll(pageNum, limitNum, {
      code,
      appName,
      cardType,
      deviceId,
      status,
      expireStart,
      expireEnd,
      isEnabled: isEnabledBool,
      source,
    });
  }

  /**
   * 2. 批量自动生成授权激活码
   */
  @Post('generate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '批量生成激活码',
    description: '在数据库中自动批量随机生成以卡种为前缀的授权激活码。',
  })
  @ApiResponse({ status: 201, description: '批量生成成功' })
  async generateCodes(
    @Body()
    body: {
      count: number;
      maxActivations: number;
      appName?: string;
      appId?: string;
      allowedFeatures?: string[];
      cardType: string;
      durationMinutes: number;
      remark?: string;
    },
  ) {
    return this.registerCodeService.generate(body);
  }

  /**
   * 物理设备解绑接口 (用户/管理员通用)
   */
  @Patch('my-devices/unbind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '物理设备解绑',
    description: '从注册码绑定列表中解绑单个特定设备，并下发下线 Kick 指令。',
  })
  async unbindSingleDevice(
    @Body() body: { code: string; deviceId: string; operator?: string },
  ) {
    if (!body.code || !body.deviceId) {
      throw new BadRequestException('参数 code 和 deviceId 不能为空');
    }
    return this.registerCodeService.unbindSingleDevice(
      body.code,
      body.deviceId,
      body.operator || 'user',
    );
  }

  /**
   * 3. 快捷更新激活码启用/禁用状态
   */
  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '更新注册码启用状态',
    description: '手动启用或禁用一个注册激活码。',
  })
  @ApiResponse({ status: 200, description: '状态修改成功' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: 'active' | 'disabled' },
  ) {
    await this.registerCodeService.updateStatus(id, body.status);
    return { success: true, message: '激活码状态更新成功！' };
  }

  /**
   * 4. 剩余使用时长微调接口（方案一）
   */
  @Patch(':id/adjust-time')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '调整激活码剩余有效时间',
    description: '支持正负数，加减激活码的截止日期，并记录原因',
  })
  @ApiResponse({ status: 200, description: '微调时间成功' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async adjustTime(
    @Param('id') id: string,
    @Body() body: { adjustMinutes: number; reason: string },
  ) {
    const updated = await this.registerCodeService.adjustDuration(
      id,
      body.adjustMinutes,
      body.reason,
    );
    return {
      success: true,
      message: `已成功微调时长 ${body.adjustMinutes} 分钟！`,
      data: {
        expireTime: updated.expireTime,
        remark: updated.remark,
      },
    };
  }

  /**
   * 5. 强行解绑当前注册码上的全部设备
   */
  @Patch(':id/unbind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '强行解绑该卡所有设备',
    description: '清空已绑定设备，重置usedNum，断开其长连接',
  })
  @ApiResponse({ status: 200, description: '解绑成功' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async unbindDevices(@Param('id') id: string) {
    const updated = await this.registerCodeService.unbindDevice(id);
    return {
      success: true,
      message: '该注册码已成功清除所有设备绑定！',
      data: {
        usedNum: updated.usedNum,
        bindDevices: updated.bindDevices,
      },
    };
  }

  /**
   * 6. 物理删除/作废回收激活码
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '作废/回收激活码',
    description:
      '物理从系统中废除并删除该注册码，其绑定的设备将立刻丢失授权并踢下线。',
  })
  @ApiResponse({ status: 200, description: '删除作废成功' })
  @ApiResponse({ status: 404, description: '激活码不存在' })
  async deleteCode(@Param('id') id: string) {
    await this.registerCodeService.delete(id);
  }

  /**
   * 6.1 更新激活码的应用与功能权限配置
   */
  @Patch(':id/config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '更新注册码的应用与功能权限配置',
    description: '修改激活码关联的 appId 以及 allowedFeatures 细分权限',
  })
  async updateConfig(
    @Param('id') id: string,
    @Body() body: { appId: string | null; allowedFeatures: string[] },
  ) {
    return this.registerCodeService.updateConfig(id, body.appId, body.allowedFeatures);
  }

  /**
   * 6.2 批量更新激活码的应用与功能权限配置
   */
  @Patch('batch-config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '批量更新注册码的应用与功能权限配置',
    description: '批量修改激活码关联的 appId 以及 allowedFeatures 细分权限',
  })
  async batchUpdateConfig(
    @Body() body: { ids: string[]; appId: string | null; allowedFeatures: string[] },
  ) {
    if (!body.ids || body.ids.length === 0) {
      throw new BadRequestException('参数 ids 不能为空');
    }
    const res = await this.registerCodeService.batchUpdateConfig(
      body.ids,
      body.appId,
      body.allowedFeatures,
    );
    return {
      success: true,
      message: `成功更新了 ${res.count} 个激活码的应用与权限配置！`,
    };
  }

  /**
   * 批量更新注册码启用状态
   */
  @Patch('batch-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '批量更新激活码状态',
    description: '支持批量启用或批量禁用激活码。',
  })
  @ApiResponse({ status: 200, description: '批量更新成功' })
  async batchUpdateStatus(
    @Body() body: { ids: string[]; status: 'active' | 'disabled' },
  ) {
    const res = await this.registerCodeService.batchUpdateStatus(
      body.ids,
      body.status,
    );
    return {
      success: true,
      message: `成功更新了 ${res.count} 个激活码的状态！`,
    };
  }

  /**
   * 批量微调注册码时长
   */
  @Patch('batch-adjust-time')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '批量微调激活码有效时间',
    description: '批量调整选中非永久卡的有效到期时间（支持正负值调整）。',
  })
  @ApiResponse({ status: 200, description: '批量微调成功' })
  async batchAdjustTime(
    @Body() body: { ids: string[]; adjustMinutes: number; reason: string },
  ) {
    const res = await this.registerCodeService.batchAdjustDuration(
      body.ids,
      body.adjustMinutes,
      body.reason,
    );
    return {
      success: true,
      message: `成功调整了 ${res.count} 个激活码的时长！`,
    };
  }

  /**
   * 批量物理注销激活码
   */
  @Post('batch-delete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '批量物理作废激活码',
    description: '从系统中批量物理删除激活码，并踢下线其所绑定的设备。',
  })
  @ApiResponse({ status: 200, description: '批量删除成功' })
  async batchDelete(@Body() body: { ids: string[] }) {
    const res = await this.registerCodeService.batchDelete(body.ids);
    return { success: true, message: `成功注销了 ${res.count} 个激活码！` };
  }

  /**
   * 7.1 获取所有注册码绑定的物理设备列表 (供管理员大屏拉取)
   */
  @Get('all-devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '管理员获取所有注册码绑定的物理设备列表',
    description: '供后台管理员大屏拉取全局设备及实时在线状态。',
  })
  @ApiResponse({ status: 200, description: '成功获取设备列表' })
  async getAllDevices() {
    return this.registerCodeService.findAllBoundDevices();
  }

  /**
   * 7. 获取当前注册码绑定的物理设备列表 (供用户端大屏拉取)
   */
  @Get('my-devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取注册码绑定的物理设备列表',
    description: '供用户端大屏通过激活码文本拉取自己的绑定设备及实时在线状态。',
  })
  @ApiResponse({ status: 200, description: '成功获取设备列表' })
  async getMyDevices(@Query('code') code: string) {
    if (!code) {
      throw new BadRequestException('参数 code 不能为空');
    }
    return this.registerCodeService.findBoundDevices(code);
  }

  /**
   * 7.2 获取注册码基本状态 (供用户端大屏拉取，查看剩余时长与设备数)
   */
  @Get('my-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取激活码状态',
    description: '获取当前激活码的过期时间和基本配置。',
  })
  @ApiResponse({ status: 200, description: '成功获取状态信息' })
  async getMyStatus(@Query('code') code: string) {
    if (!code) {
      throw new BadRequestException('参数 code 不能为空');
    }
    return this.registerCodeService.getCodeStatus(code);
  }

  /**
   * 8. 导入老系统激活码表格数据并实现覆盖式更新(Upsert)
   */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: '导入并覆盖式同步存量激活码',
    description:
      '上传老系统导出的 xls 格式数据，在内存中直接解构解析，并完成 Upsert 逻辑。',
  })
  @ApiResponse({ status: 200, description: '成功执行存量导入' })
  async importCodes(
    @UploadedFile() file: any,
    @Body('appId') appId?: string,
    @Body('allowedFeatures') allowedFeatures?: string | string[],
    @Body('maxActivations') maxActivations?: string,
    @Body('statusMode') statusMode?: 'file' | 'active' | 'disabled',
  ) {
    if (!file || !file.buffer) {
      throw new BadRequestException('请选择有效的 Excel 注册码导出文件！');
    }

    let features: string[] | undefined;
    if (typeof allowedFeatures === 'string') {
      try {
        features = JSON.parse(allowedFeatures);
      } catch {
        features = [allowedFeatures];
      }
    } else {
      features = allowedFeatures;
    }

    const maxActiveNum = maxActivations ? parseInt(maxActivations, 10) : undefined;

    return this.registerCodeService.importBoundCodes(file.buffer, {
      appId,
      allowedFeatures: features,
      maxActivations: maxActiveNum,
      statusMode,
    });
  }

  /**
   * 9. 查询卡密操作变更日志列表
   */
  @Get('action-logs')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '分页查询卡密变更审计日志',
    description:
      '获取后台管理员对激活码执行的批量制卡、微调、启用禁用、解绑和注销日志',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '页码，默认 1',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: '每页条数，默认 10',
  })
  @ApiQuery({
    name: 'code',
    required: false,
    type: String,
    description: '激活卡密过滤',
  })
  @ApiQuery({
    name: 'actionType',
    required: false,
    type: String,
    description: '操作类型过滤 (GENERATE/ADJUST/ENABLE/DISABLE/UNBIND/DELETE)',
  })
  @ApiResponse({ status: 200, description: '成功获取日志' })
  async getActionLogs(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('code') code?: string,
    @Query('actionType') actionType?: string,
  ) {
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const limitNum = limit ? Math.max(1, parseInt(limit, 10)) : 10;
    return this.registerCodeService.findActionLogs(pageNum, limitNum, {
      code,
      actionType,
    });
  }

  /**
   * 10. 卡密与设备自动绑定验证接口 (客户端脚本调用)
   */
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '客户端卡密授权及自动绑定验证',
    description:
      '客户端脚本专用。若为新设备且名额未满自动执行绑定，已绑定设备直接通过。',
  })
  @ApiResponse({ status: 200, description: '验证或绑定成功' })
  async verifyCode(@Body() body: VerifyRegisterCodeDto) {
    return this.registerCodeService.verifyCode(body.code, body.deviceId);
  }

  /**
   * 获取卡密警报配置 (供大屏端或用户端展示)
   */
  @Get('my-alert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取激活码警报配置',
    description: '供用户端大屏通过激活码拉取报警邮箱及订阅选项。',
  })
  async getMyAlert(@Query('code') code: string) {
    if (!code) {
      throw new BadRequestException('参数 code 不能为空');
    }
    return this.registerCodeService.getAlertConfig(code);
  }

  /**
   * 更新卡密警报配置 (供大屏端或用户端修改)
   */
  @Patch('my-alert')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '更新激活码警报配置',
    description: '更新报警接收邮箱及选择的订阅事件',
  })
  async updateMyAlert(@Body() body: UpdateMyAlertDto) {
    if (!body.code) {
      throw new BadRequestException('参数 code 不能为空');
    }
    return this.registerCodeService.updateAlertConfig(
      body.code,
      body.alertEmail || '',
      body.alertConfig,
    );
  }

  /**
   * 获取最近紧急警报历史 (供大屏端展示)
   */
  @Get('alerts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取最近紧急警报历史',
    description: '供设备管理大屏拉取最近未优雅退出的紧急警报列表。',
  })
  async getAlertHistory() {
    return this.registerCodeService.getAlertHistory();
  }

  /**
   * 将特定物理设备加入该激活码黑名单
   */
  @Post('my-devices/blacklist')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '添加设备至激活码黑名单',
    description:
      '将物理设备加入此卡密黑名单，若设备当前正处于绑定状态，则执行强制解绑下线。',
  })
  async addDeviceToBlacklist(
    @Body()
    body: {
      code: string;
      deviceId: string;
      deviceName?: string;
      reason?: string;
      operator?: string;
    },
  ) {
    if (!body.code || !body.deviceId) {
      throw new BadRequestException('参数 code 和 deviceId 不能为空');
    }
    return this.registerCodeService.addDeviceToBlacklist(
      body.code,
      body.deviceId,
      body.deviceName,
      body.reason,
      body.operator || 'user',
    );
  }

  /**
   * 将物理设备移出激活码黑名单
   */
  @Delete('my-devices/blacklist')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '将物理设备移出卡密黑名单',
    description: '解除拉黑，允许该设备再次进行登录鉴权与绑定。',
  })
  async removeDeviceFromBlacklist(
    @Query('code') code: string,
    @Query('deviceId') deviceId: string,
    @Query('operator') operator?: string,
  ) {
    if (!code || !deviceId) {
      throw new BadRequestException('参数 code 和 deviceId 不能为空');
    }
    return this.registerCodeService.removeDeviceFromBlacklist(
      code,
      deviceId,
      operator || 'user',
    );
  }

  /**
   * 获取指定激活码对应的黑名单列表
   */
  @Get('my-devices/blacklist')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取激活码设备黑名单',
    description: '查询该激活码下拉黑的所有设备列表。',
  })
  async getBlacklist(@Query('code') code: string) {
    if (!code) {
      throw new BadRequestException('参数 code 不能为空');
    }
    return this.registerCodeService.getBlacklist(code);
  }

  /**
   * 获取指定激活码对应的设备绑定与解绑历史记录
   */
  @Get('my-devices/history')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取设备解绑历史记录',
    description: '查询该激活码名下所有解绑历史审计记录。',
  })
  async getUnbindHistory(@Query('code') code: string) {
    if (!code) {
      throw new BadRequestException('参数 code 不能为空');
    }
    return this.registerCodeService.getUnbindHistory(code);
  }

  /**
   * 获取指定设备在 2 天之内的账号登录运行历史记录
   */
  @Get('my-devices/account-history')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '获取设备账号登录历史记录',
    description: '查询该激活码下拉特定设备在2天内的账号流转时间列表。',
  })
  async getAccountHistory(
    @Query('code') code: string,
    @Query('deviceId') deviceId: string,
  ) {
    if (!code || !deviceId) {
      throw new BadRequestException('参数 code 和 deviceId 不能为空');
    }
    return this.registerCodeService.getDeviceAccountHistory(code, deviceId);
  }

  /**
   * 11. 手动/自动下发换号切号指令 (供大屏/管理员调用)
   */
  @Patch('my-devices/switch-account')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '强制特定在线设备换号',
    description: '下发 switch_account 命令强制该设备优雅退登并登录下一个号。',
  })
  async switchAccountDevice(
    @Body()
    body: {
      code: string;
      deviceId: string;
      operator?: string;
      reason?: string;
    },
  ) {
    if (!body.code || !body.deviceId) {
      throw new BadRequestException('参数 code 和 deviceId 不能为空');
    }
    return this.registerCodeService.switchAccountDevice(
      body.code,
      body.deviceId,
      body.operator || 'user',
      body.reason,
    );
  }

  /**
   * 12. 客户端脚本登录前，主动防共享查重检测
   */
  @Get('my-devices/check-account')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '主动查重检测账号是否被占用',
    description: '供客户端脚本在实际执行游戏登录前校验其挑选的账号状态。',
  })
  async checkAccountStatus(
    @Query('code') code: string,
    @Query('deviceId') deviceId: string,
    @Query('account') account: string,
  ) {
    if (!code || !deviceId || !account) {
      throw new BadRequestException(
        '参数 code, deviceId 和 account 均不能为空',
      );
    }
    return this.registerCodeService.checkAccountStatus(code, deviceId, account);
  }
}
