import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { RegisterCodeModule } from './modules/register-code/register-code.module';
import { ScriptLogModule } from './modules/script-log/script-log.module';
import { MqttModule } from './modules/mqtt/mqtt.module';
import { AiAgentModule } from './modules/ai-agent/ai-agent.module';

@Module({
  imports: [
    AuthModule,
    UserModule,
    RegisterCodeModule,
    ScriptLogModule,
    MqttModule,
    AiAgentModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
