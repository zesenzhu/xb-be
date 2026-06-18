import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { RegisterCodeModule } from './modules/register-code/register-code.module';
import { ScriptLogModule } from './modules/script-log/script-log.module';
import { MqttModule } from './modules/mqtt/mqtt.module';
import { AiAgentModule } from './modules/ai-agent/ai-agent.module';
import { PrismaModule } from './modules/prisma/prisma.module';
import { TcpSocketModule } from './modules/tcp-socket/tcp-socket.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DebugModule } from './modules/debug/debug.module';
import { UploadModule } from './modules/upload/upload.module';
import { SystemSettingModule } from './modules/system-setting/system-setting.module';
import { NotificationModule } from './modules/notification/notification.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UserModule,
    RegisterCodeModule,
    ScriptLogModule,
    MqttModule,
    AiAgentModule,
    TcpSocketModule,
    DashboardModule,
    DebugModule,
    UploadModule,
    SystemSettingModule,
    NotificationModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
