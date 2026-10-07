import { Module } from '@nestjs/common';
import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';
import { RiskEngine } from './risk.engine';
import { RiskRepository } from './risk.repository';
import { DatabaseModule } from '../../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [RiskController],
  providers: [RiskService, RiskEngine, RiskRepository],
  exports: [RiskService, RiskEngine, RiskRepository],
})
export class RiskModule {}
