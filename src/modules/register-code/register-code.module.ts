import { Module } from '@nestjs/common';
import { RegisterCodeService } from './register-code.service';
import { RegisterCodeController } from './register-code.controller';

@Module({
  controllers: [RegisterCodeController],
  providers: [RegisterCodeService],
  exports: [RegisterCodeService],
})
export class RegisterCodeModule {}
