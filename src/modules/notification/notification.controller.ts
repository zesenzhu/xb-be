import { Controller, Get, Patch, Body, Query, UseGuards, HttpCode, HttpStatus, Sse, MessageEvent } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import { AdminGuard } from '../debug/admin.guard';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@ApiTags('Notifications 消息通知与通报')
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取系统通知列表 (分页)' })
  async getNotifications(
    @Query('isRead') isRead?: string,
    @Query('level') level?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const isReadBool = isRead === 'true' ? true : isRead === 'false' ? false : undefined;
    return this.notificationService.findAll({
      isRead: isReadBool,
      level,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('unread-count')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '获取未读通知数' })
  async getUnreadCount() {
    return this.notificationService.getUnreadCount();
  }

  @Patch('read')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '批量标记通知为已读' })
  async markAsRead(@Body('ids') ids: string[]) {
    return this.notificationService.markAsRead(ids);
  }

  @Patch('read-all')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '全部通知标记为已读' })
  async markAllAsRead() {
    return this.notificationService.markAllAsRead();
  }

  @Sse('stream')
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: '管理员端 SSE 消息推送流' })
  streamNotifications(): Observable<MessageEvent> {
    return this.notificationService.notificationBroadcaster$.asObservable().pipe(
      map((notification) => ({
        data: JSON.stringify(notification),
      } as MessageEvent)),
    );
  }
}
