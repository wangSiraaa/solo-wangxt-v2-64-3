import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LeaveEvent } from '../entities/leave-event.entity';
import { LeaveEventBatch } from '../entities/leave-event-batch.entity';
import { LeaveSuspensionPeriod } from '../entities/leave-suspension-period.entity';
import { FeeSettlement } from '../entities/fee-settlement.entity';
import { FeeSettlementLine } from '../entities/fee-settlement-line.entity';
import { FeeAdjustment } from '../entities/fee-adjustment.entity';
import { FeeAdjustmentLine } from '../entities/fee-adjustment-line.entity';
import { LeavesController } from './leaves.controller';
import { LeavesService } from './leaves.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LeaveEventBatch,
      LeaveEvent,
      LeaveSuspensionPeriod,
      FeeSettlement,
      FeeSettlementLine,
      FeeAdjustment,
      FeeAdjustmentLine,
    ]),
  ],
  controllers: [LeavesController],
  providers: [LeavesService],
  exports: [LeavesService],
})
export class LeavesModule {}
