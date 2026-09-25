import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { FeesService } from './fees.service';
import { LeaveLedgerService } from './leave-ledger.service';
import { LeaveFeesService } from './leave-fees.service';
import { ActivateGradeDto, FeeSegmentsQueryDto } from './dto/fee.dto';
import {
  LeaveQueryDto,
  LeaveTrialQueryDto,
  RecordLeaveEventsBatchDto,
  SettleFeesDto,
} from './dto/leave-fee.dto';

@Controller('fees')
export class FeesController {
  constructor(
    private readonly service: FeesService,
    private readonly leaveLedger: LeaveLedgerService,
    private readonly leaveFees: LeaveFeesService,
  ) {}

  /** 等级生效（必须已确认；同日不允许重叠等级） */
  @Post('activate')
  activate(@Body() dto: ActivateGradeDto) {
    return this.service.activateGrade(
      dto.caseId,
      dto.effectiveDate,
      dto.idempotencyKey,
    );
  }

  /** 原在院费用分段：不含离院暂停，用于回放在院等级×费率基线 */
  @Get('segments')
  segments(@Query() q: FeeSegmentsQueryDto) {
    return this.service.feeSegments(q.elderId, q.from, q.to);
  }

  /** 录入一批离返院事件；重复稳定事件号回放，迟到事件触发物化和调整 */
  @Post('leave-events')
  recordLeaveEvents(@Body() dto: RecordLeaveEventsBatchDto) {
    return this.leaveLedger.recordEvents(dto.events);
  }

  /** 查询不可变事件账本（按发生时间和接收顺序） */
  @Get('leave-events')
  listLeaveEvents(@Query() q: LeaveQueryDto) {
    return this.leaveLedger.listEvents(q.elderId).then((events) => ({
      elderId: q.elderId,
      events,
    }));
  }

  /** 查询从事件历史物化出的不重叠暂停区间及异常状态 */
  @Get('leave-periods')
  listLeavePeriods(@Query() q: LeaveQueryDto) {
    return this.leaveLedger.listPeriods(q.elderId);
  }

  /** 离院感知费用试算：等级/费率分段保留，命中离院日逐日暂停 */
  @Get('leave/trial')
  leaveTrial(@Query() q: LeaveTrialQueryDto) {
    return this.leaveFees.trial(q.elderId, q.from, q.to);
  }

  /** 将未结算区间逐日落账；后续迟到事件只能生成调整单 */
  @Post('settlements')
  settle(@Body() dto: SettleFeesDto) {
    return this.leaveFees.settle(dto.elderId, dto.from, dto.to, dto.idempotencyKey);
  }

  @Get('settlements')
  listSettlements(@Query() q: LeaveQueryDto) {
    return this.leaveFees.listSettlements(q.elderId);
  }

  @Get('settlements/:id')
  getSettlement(@Param('id') id: string) {
    return this.leaveFees.getSettlement(id);
  }

  /** 调整查询：返回调整单、逐日明细和不可变原始账目来源 */
  @Get('adjustments')
  listAdjustments(
    @Query('elderId') elderId: string,
    @Query('settlementId') settlementId?: string,
  ) {
    return this.leaveFees.listAdjustments(elderId, settlementId);
  }
}
