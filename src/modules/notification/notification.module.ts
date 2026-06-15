import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'xb-secret-key-2026',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
