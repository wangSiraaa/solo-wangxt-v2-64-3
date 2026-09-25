import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { FeesController } from './fees.controller';
import { FeesService } from './fees.service';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [
    BillingModule,
    TypeOrmModule.forFeature([
      AssessmentCase,
      GradeEffectivePeriod,
      FeeRateVersion,
    ]),
  ],
  controllers: [FeesController],
  providers: [FeesService],
})
export class FeesModule {}
