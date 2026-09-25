import { Global, Module } from '@nestjs/common';
import { BillingProjectionService } from './billing-projection.service';

@Global()
@Module({
  providers: [BillingProjectionService],
  exports: [BillingProjectionService],
})
export class BillingModule {}
