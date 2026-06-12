import { Module } from '@nestjs/common';
import { DebugService } from './debug.service';
import { DebugController } from './debug.controller';

@Module({
  controllers: [DebugController],
  providers: [DebugService],
})
export class DebugModule {}
