import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { LeaveEvent } from '../entities/leave-event.entity';
import { LeavePeriod } from '../entities/leave-period.entity';
import { LeaveAnomaly } from '../entities/leave-anomaly.entity';
import { FeeSettlement } from '../entities/fee-settlement.entity';
import { FeeChargeEntry } from '../entities/fee-charge-entry.entity';
import { FeeAdjustment } from '../entities/fee-adjustment.entity';
import { FeeAdjustmentItem } from '../entities/fee-adjustment-item.entity';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { LeaveLedgerService } from './leave-ledger.service';
import { LeaveFeesService } from './leave-fees.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssessmentCase,
      GradeEffectivePeriod,
      FeeRateVersion,
      LeaveEvent,
      LeavePeriod,
      LeaveAnomaly,
      FeeSettlement,
      FeeChargeEntry,
      FeeAdjustment,
      FeeAdjustmentItem,
    ]),
  ],
  controllers: [FeesController],
  providers: [FeesService, LeaveLedgerService, LeaveFeesService],
})
export class FeesModule {}
