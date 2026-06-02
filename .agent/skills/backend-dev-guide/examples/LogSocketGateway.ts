import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, UseGuards } from '@nestjs/common';
import { WsJwtAuthGuard } from './ws-jwt-auth.guard'; // 虚拟 JWT Guard

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/realtime-logs',
})
@Injectable()
export class LogSocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // 1. 建立物理长连接，安全提取 JWT 并将其拉入物理房间
  async handleConnection(socket: Socket) {
    try {
      // 提取前端 Cookie 中的 user_access_token 并解析用户信息
      const userToken = this.extractTokenFromSocket(socket);
      if (!userToken) {
        socket.disconnect(true);
        return;
      }
      
      const userId = this.validateJwtToken(userToken);
      
      // ⚠️ 避坑铁律：必须精准将 socket 加入其用户专属的房间，杜绝全广播
      const roomName = `room_user_${userId}`;
      await socket.join(roomName);
      
      console.log(`[WebSocket] 客户端 ${socket.id} 成功鉴权，加入安全隔离房间: ${roomName}`);
    } catch (err) {
      console.error('[WebSocket] 物理连接握手鉴权失败，强行熔断连接: ', err);
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket) {
    console.log(`[WebSocket] 客户端 ${socket.id} 物理连接断开`);
  }

  // 2. 高频接收物理信道（MQTT）分发后的精准定向安全推送
  sendLogsToUser(userId: string, logFrame: { deviceId: string; level: string; content: string }) {
    const roomName = `room_user_${userId}`;
    // 定向发给该用户的专属 Room
    this.server.to(roomName).emit('log_stream', logFrame);
  }

  // 3. 用户前端反向控制：手动激活/挂起监听主题
  @UseGuards(WsJwtAuthGuard)
  @SubscribeMessage('toggle_logging')
  handleToggleLogging(socket: Socket, payload: { deviceId: string; enabled: boolean }) {
    // 处理反向逻辑，如修改 Redis 中的监听状态
    return { success: true, message: `已成功变更设备 ${payload.deviceId} 的监听状态为: ${payload.enabled}` };
  }

  private extractTokenFromSocket(socket: Socket): string | null {
    const cookieHeader = socket.handshake.headers.cookie;
    if (!cookieHeader) return null;
    
    // 精准截取 user_access_token
    const match = cookieHeader.match(/user_access_token=([^;]+)/);
    return match ? match[1] : null;
  }

  private validateJwtToken(token: string): string {
    // 模拟解析返回 userId
    return 'user_test_uuid_123456';
  }
}
