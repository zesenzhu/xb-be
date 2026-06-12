import { Module } from '@nestjs/common';
import { SystemSettingController } from './system-setting.controller';
import { SystemSettingService } from './system-setting.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [SystemSettingController],
  providers: [SystemSettingService],
  exports: [SystemSettingService],
})
export class SystemSettingModule {}
