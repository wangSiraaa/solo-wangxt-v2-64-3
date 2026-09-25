import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { LeavesService } from './leaves.service';
import {
  AdjustmentsQueryDto,
  LeaveEventsQueryDto,
  LeaveFeeTrialQueryDto,
  LeavePeriodsQueryDto,
  RecordLeaveEventsDto,
  SettleFeesDto,
} from './dto/leave.dto';

@Controller()
export class LeavesController {
  constructor(private readonly service: LeavesService) {}

  /** 录入/补录离返院事件，整批原子；相同 batchNo 幂等回放。 */
  @Post('leave-events')
  record(@Body() dto: RecordLeaveEventsDto) {
    return this.service.recordEvents(dto);
  }

  @Get('elders/:elderId/leave-events')
  events(@Param('elderId') elderId: string) {
    return this.service.listEvents(elderId);
  }

  /** 查询从事件历史物化的不重叠暂停区间与解释状态。 */
  @Get('leave-periods')
  periods(@Query() q: LeavePeriodsQueryDto) {
    return this.service.listPeriods(q.elderId, q.status);
  }

  /** 费用试算：逐日、暂停区间、等级/费率分段和异常状态同屏解释。 */
  @Get('fees/leave-trial')
  trial(@Query() q: LeaveFeeTrialQueryDto) {
    return this.service.feeTrial(q.elderId, q.from, q.to);
  }

  /** 月结：冻结逐日原费用和暂停后应收；重复请求回放。 */
  @Post('fees/settle')
  settle(@Body() dto: SettleFeesDto) {
    return this.service.settleMonth(dto.elderId, dto.month);
  }

  @Get('fees/settlements/:month')
  settlement(
    @Param('month') month: string,
    @Query() q: LeaveEventsQueryDto,
  ) {
    return this.service.getSettlement(q.elderId, month);
  }

  @Get('fees/adjustments')
  adjustments(@Query() q: AdjustmentsQueryDto) {
    return this.service.listAdjustments(q.elderId, q.month);
  }
}
