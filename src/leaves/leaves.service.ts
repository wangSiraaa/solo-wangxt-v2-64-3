import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { LeaveEvent, LeaveEventType } from '../entities/leave-event.entity';
import {
  LeaveEventBatch,
  LeaveBatchStatus,
} from '../entities/leave-event-batch.entity';
import {
  LeavePeriodStatus,
  LeaveSuspensionPeriod,
} from '../entities/leave-suspension-period.entity';
import { FeeSettlement, FeeSettlementStatus } from '../entities/fee-settlement.entity';
import { FeeSettlementLine } from '../entities/fee-settlement-line.entity';
import { FeeAdjustment, FeeAdjustmentType } from '../entities/fee-adjustment.entity';
import { FeeAdjustmentLine } from '../entities/fee-adjustment-line.entity';
import { BillingProjectionService } from '../billing/billing-projection.service';
import { addDays } from '../common/date.util';
import { moneyText } from '../common/money.util';
import { isValidMonth, monthEnd, monthStart, shanghaiDate } from '../common/business-time.util';
import {
  RecordLeaveEventDto,
  RecordLeaveEventsDto,
} from './dto/leave.dto';

type EventRow = {
  id: string;
  event_no: string;
  event_type: LeaveEventType;
  event_occurred_at: Date;
  event_date: string;
  receive_order: number;
};

@Injectable()
export class LeavesService {
  constructor(
    @InjectRepository(LeaveEvent)
    private readonly eventRepo: Repository<LeaveEvent>,
    @InjectRepository(LeaveEventBatch)
    private readonly batchRepo: Repository<LeaveEventBatch>,
    @InjectRepository(LeaveSuspensionPeriod)
    private readonly periodRepo: Repository<LeaveSuspensionPeriod>,
    @InjectRepository(FeeSettlement)
    private readonly settlementRepo: Repository<FeeSettlement>,
    @InjectRepository(FeeSettlementLine)
    private readonly settlementLineRepo: Repository<FeeSettlementLine>,
    @InjectRepository(FeeAdjustment)
    private readonly adjustmentRepo: Repository<FeeAdjustment>,
    @InjectRepository(FeeAdjustmentLine)
    private readonly adjustmentLineRepo: Repository<FeeAdjustmentLine>,
    private readonly dataSource: DataSource,
    private readonly billingProjection: BillingProjectionService,
  ) {}

  /**
   * 接收一批离返院回调。整批在一个事务中完成：
   * 锁老人事件账本 → 稳定事件号/接收顺序去重 → 追加事件 → 重建暂停区间 → 追加已结算月调整。
   */
  async recordEvents(input: RecordLeaveEventsDto) {
    const batchNo = input.batchNo ?? `batch:${input.elderId}:${Date.now()}`;
    const prepared = input.events.map((e) => this.prepareEvent(input.elderId, e));
    this.validateBatch(input.elderId, batchNo, prepared);

    return this.dataSource.transaction(async (manager) => {
      await this.lockElder(manager, input.elderId);

      const existingBatch = await manager.findOne(LeaveEventBatch, {
        where: { batchNo },
      });
      if (existingBatch) {
        const replay = await this.loadReplay(manager, existingBatch);
        if (!this.sameBatchInput(replay.events, prepared)) {
          throw new ConflictException({
            code: 'BATCH_NO_CONFLICT',
            message: '相同批次号已用于不同事件，整批拒绝',
            batchId: existingBatch.id,
          });
        }
        return replay;
      }

      const existingByNo = await manager.find(LeaveEvent, {
        where: input.events.map((e) => ({ eventNo: e.eventNo })),
      });
      if (existingByNo.length) {
        const batchIds = new Set(existingByNo.map((e) => e.batchId));
        const allIncomingAreKnown =
          existingByNo.length === input.events.length &&
          existingByNo.every((e) => input.events.some((i) => i.eventNo === e.eventNo));
        if (allIncomingAreKnown && batchIds.size === 1) {
          const existingBatch = await manager.findOneOrFail(LeaveEventBatch, {
            where: { id: [...batchIds][0]! },
          });
          const replay = await this.loadReplay(manager, existingBatch);
          if (this.sameBatchInput(replay.events, prepared)) return replay;
        }
        throw new ConflictException({
          code: 'DUPLICATE_EVENT_NO',
          message:
            '稳定事件号已存在但载荷不一致，或新批次混入部分已存在事件；整批拒绝',
          eventNos: existingByNo.map((e) => e.eventNo),
        });
      }

      const sequenceClash = await manager.query(
        `SELECT receive_order FROM leave_events
          WHERE elder_id = $1 AND receive_order = ANY($2)
          ORDER BY receive_order`,
        [input.elderId, prepared.map((e) => e.receiveSequence)],
      );
      if (sequenceClash.length) {
        throw new ConflictException({
          code: 'RECEIVE_SEQUENCE_CONFLICT',
          message: '接收顺序与事件账本冲突，整批拒绝，无半区间写入',
          receiveOrders: sequenceClash.map((r: any) => Number(r.receive_order)),
        });
      }

      const batch = await manager.save(LeaveEventBatch, {
        batchNo,
        elderId: input.elderId,
        status: LeaveBatchStatus.ACCEPTED,
        eventCount: prepared.length,
      });

      for (const e of prepared) {
        await manager.save(LeaveEvent, {
          elderId: input.elderId,
          eventNo: e.eventNo,
          eventType: e.eventType,
          eventOccurredAt: e.occurredAt,
          eventDate: e.eventDate,
          receiveOrder: e.receiveSequence,
          batchId: batch.id,
        });
      }

      const periods = await this.rematerialize(manager, input.elderId);
      const adjustments = await this.createSettledMonthAdjustments(
        manager,
        input.elderId,
        batch.id,
      );

      return {
        replayed: false,
        batch,
        acceptedEvents: prepared.length,
        periods,
        adjustments,
      };
    });
  }

  async listEvents(elderId: string) {
    const events = await this.eventRepo.find({
      where: { elderId },
      order: { eventOccurredAt: 'ASC', receiveOrder: 'ASC' },
      relations: { batch: true },
    });
    const periods = await this.periodRepo.find({
      where: { elderId },
      order: { startDate: 'ASC', periodKey: 'ASC' },
    });
    return {
      events,
      periods,
      anomalies: periods.filter((p) => p.status !== LeavePeriodStatus.MATCHED),
    };
  }

  async listPeriods(elderId: string, status?: LeavePeriodStatus) {
    const periods = await this.periodRepo.find({
      where: status ? { elderId, status } : { elderId },
      order: { startDate: 'ASC', periodKey: 'ASC' },
    });
    return periods.map((p) => this.periodResponse(p));
  }

  async feeTrial(elderId: string, from: string, to: string) {
    return this.dataSource.transaction(async (manager) => {
      await this.lockElder(manager, elderId);
      return this.billingProjection.project(manager, elderId, from, to, 'TRIAL');
    });
  }

  async settleMonth(elderId: string, month: string) {
    if (!isValidMonth(month)) {
      throw new ConflictException({
        code: 'INVALID_MONTH',
        message: `月份 ${month} 不合法，应为 YYYY-MM`,
      });
    }
    const from = monthStart(month);
    const to = monthEnd(month);

    return this.dataSource.transaction(async (manager) => {
      await this.lockElder(manager, elderId);
      const existing = await manager.findOne(FeeSettlement, {
        where: { elderId, periodMonth: month },
        relations: { lines: true },
      });
      if (existing) {
        return { replayed: true, settlement: existing };
      }

      const projection = await this.billingProjection.project(
        manager,
        elderId,
        from,
        to,
        'SETTLE',
      );
      const blocking = projection.anomalies.filter(
        (a) =>
          a.status === LeavePeriodStatus.ORPHAN_RETURN ||
          a.status === LeavePeriodStatus.RETURN_BEFORE_DEPARTURE ||
          a.status === LeavePeriodStatus.NESTED_DEPARTURE ||
          a.status === LeavePeriodStatus.OPEN_MISSING_RETURN,
      );
      const missingRate = projection.segments.some((s) => s.status === 'MISSING_RATE');
      if (blocking.length || missingRate) {
        throw new ConflictException({
          code: 'MONTH_NOT_SETTLEABLE',
          message: '存在未配对/异常离返院事件或缺费率，必须先给出可解释处理，不能整月停费',
          anomalies: blocking,
          missingRate,
        });
      }

      const settlement = await manager.save(FeeSettlement, {
        elderId,
        periodMonth: month,
        monthStart: from,
        monthEnd: to,
        status: FeeSettlementStatus.SETTLED,
        originalAmount: projection.originalAmount,
        billedAmount: projection.totalAmount,
      });

      for (const d of projection.days) {
        await manager.save(FeeSettlementLine, {
          settlementId: settlement.id,
          elderId,
          feeDate: d.date,
          grade: d.grade,
          dailyRate: d.dailyRate,
          originalAmount: d.originalAmount,
          billedAmount: d.billedAmount,
          paused: d.paused,
          leavePeriodKey: d.leavePeriodKey,
          gradePeriodId: d.gradePeriodId,
        });
      }

      settlement.lines = await manager.find(FeeSettlementLine, {
        where: { settlementId: settlement.id },
        order: { feeDate: 'ASC' },
      });
      return { replayed: false, settlement, projection };
    });
  }

  async getSettlement(elderId: string, month: string) {
    const settlement = await this.settlementRepo.findOne({
      where: { elderId, periodMonth: month },
      relations: { lines: true },
    });
    if (!settlement) {
      throw new NotFoundException({
        code: 'SETTLEMENT_NOT_FOUND',
        message: `${elderId} ${month} 尚未结算`,
      });
    }
    const adjustments = await this.adjustmentRepo.find({
      where: { elderId, periodMonth: month },
      order: { createdAt: 'ASC' },
      relations: { lines: true },
    });
    const adjustmentTotal = adjustments.reduce(
      (sum, a) => sum.plus(a.amount),
      new Decimal(0),
    );
    return {
      settlement,
      adjustments,
      currentNetAmount: moneyText(
        new Decimal(settlement.billedAmount).plus(adjustmentTotal),
      ),
    };
  }

  async listAdjustments(elderId: string, month?: string) {
    return this.adjustmentRepo.find({
      where: month ? { elderId, periodMonth: month } : { elderId },
      order: { createdAt: 'ASC' },
      relations: { lines: true },
    });
  }

  async rebuildAllPeriods(): Promise<{ elders: number }> {
    const rows: Array<{ elder_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT elder_id FROM leave_events ORDER BY elder_id`,
    );
    await this.dataSource.transaction(async (manager) => {
      for (const row of rows) await this.rematerialize(manager, row.elder_id);
    });
    return { elders: rows.length };
  }

  private prepareEvent(elderId: string, dto: RecordLeaveEventDto) {
    return {
      elderId,
      eventNo: dto.eventNo,
      eventType: dto.eventType,
      occurredAt: new Date(dto.occurredAt),
      eventDate: shanghaiDate(dto.occurredAt),
      receiveSequence: dto.receiveSequence,
    };
  }

  private validateBatch(
    elderId: string,
    batchNo: string,
    events: Array<{ eventNo: string; receiveSequence: number }>,
  ): void {
    const eventNos = new Set<string>();
    const sequences = new Set<number>();
    for (const e of events) {
      if (eventNos.has(e.eventNo)) {
        throw new ConflictException({
          code: 'BATCH_EVENT_NO_DUPLICATE',
          message: '同一批次内稳定事件号重复，整批拒绝',
          eventNo: e.eventNo,
        });
      }
      if (sequences.has(e.receiveSequence)) {
        throw new ConflictException({
          code: 'BATCH_RECEIVE_SEQUENCE_DUPLICATE',
          message: '同一批次内接收顺序重复，整批拒绝',
          receiveSequence: e.receiveSequence,
        });
      }
      eventNos.add(e.eventNo);
      sequences.add(e.receiveSequence);
    }
    if (batchNo.length > 128 || elderId.length > 64) {
      throw new ConflictException({ code: 'INPUT_TOO_LONG', message: '入参长度超限' });
    }
  }

  /** 64 位事务咨询锁，序列化同一老人的并发补录；不同老人不互相阻塞。 */
  private async lockElder(manager: any, elderId: string): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(CAST($1 AS bigint))', [
      String(this.hashElderKey(elderId)),
    ]);
  }

  private hashElderKey(elderId: string): bigint {
    let h = 1125899906842597n;
    for (let i = 0; i < elderId.length; i++) {
      h = 33n * h + BigInt(elderId.charCodeAt(i));
      // bigint signed range normalization
      h = ((h + (1n << 63n)) % (1n << 64n) + (1n << 64n)) % (1n << 64n) - (1n << 63n);
    }
    return h;
  }

  private async loadReplay(manager: any, batch: LeaveEventBatch) {
    const events = await manager.find(LeaveEvent, {
      where: { batchId: batch.id },
      order: { eventOccurredAt: 'ASC', receiveOrder: 'ASC' },
    });
    const periods = await manager.find(LeaveSuspensionPeriod, {
      where: { elderId: batch.elderId },
      order: { startDate: 'ASC', periodKey: 'ASC' },
    });
    const adjustments = await manager.find(FeeAdjustment, {
      where: { batchId: batch.id },
      relations: { lines: true },
    });
    return {
      replayed: true,
      message: '批次已接收，按稳定批次号幂等回放',
      batch,
      acceptedEvents: events.length,
      events,
      periods,
      adjustments,
    };
  }

  private sameBatchInput(
    replayed: LeaveEvent[],
    input: Array<{ eventNo: string; eventType: LeaveEventType; receiveSequence: number; eventDate: string }>,
  ): boolean {
    if (replayed.length !== input.length) return false;
    const byNo = new Map(replayed.map((e) => [e.eventNo, e]));
    return input.every((i) => {
      const e = byNo.get(i.eventNo);
      return (
        e &&
        e.eventType === i.eventType &&
        e.receiveOrder === i.receiveSequence &&
        e.eventDate === i.eventDate
      );
    });
  }

  /** 从只追加事件历史完整重建解释区间；事件是事实来源，区间可删除重放。 */
  private async rematerialize(
    manager: any,
    elderId: string,
  ): Promise<LeaveSuspensionPeriod[]> {
    const events: EventRow[] = await manager.query(
      `SELECT id, event_no, event_type, event_occurred_at, event_date::text AS event_date,
                     receive_order
         FROM leave_events
        WHERE elder_id = $1
        ORDER BY event_occurred_at ASC, receive_order ASC, event_no ASC`,
      [elderId],
    );

    await manager.query(`DELETE FROM leave_suspension_periods WHERE elder_id = $1`, [
      elderId,
    ]);

    const laterLeaveExists = (index: number): boolean =>
      events
        .slice(index + 1)
        .some((e) => e.event_type === LeaveEventType.LEAVE);

    const rows: Array<Partial<LeaveSuspensionPeriod>> = [];
    const openLeaves: EventRow[] = [];
    const nestedLeaves: EventRow[] = [];

    events.forEach((e, index) => {
      const waitingLeaves = [...openLeaves, ...nestedLeaves];
      if (e.event_type === LeaveEventType.LEAVE) {
        if (waitingLeaves.length) {
          nestedLeaves.push(e);
          rows.push({
            periodKey: `nested:${e.event_no}`,
            elderId,
            status: LeavePeriodStatus.NESTED_DEPARTURE,
            startDate: e.event_date,
            endDateExclusive: addDays(e.event_date, 1),
            leaveEventId: e.id,
            leaveEventNo: e.event_no,
            explanation: `离院事件 ${e.event_no} 发生时已有未返院区间，系统不自动嵌套或覆盖；请人工核对原始事件`,
          });
          return;
        }
        openLeaves.push(e);
        return;
      }

      if (!openLeaves.length) {
        const status = laterLeaveExists(index)
          ? LeavePeriodStatus.RETURN_BEFORE_DEPARTURE
          : LeavePeriodStatus.ORPHAN_RETURN;
        rows.push({
          periodKey: `${status === LeavePeriodStatus.ORPHAN_RETURN ? 'orphan-return' : 'early-return'}:${e.event_no}`,
          elderId,
          status,
          startDate: null,
          eventDate: e.event_date,
          endDateExclusive: null,
          returnEventId: e.id,
          returnEventNo: e.event_no,
          explanation:
            status === LeavePeriodStatus.ORPHAN_RETURN
              ? `返院事件 ${e.event_no} 缺少可配对离院事件，不生成暂停区间`
              : `返院事件 ${e.event_no} 早于任何可配对离院事件，不生成暂停区间；请核对时间或补录`,
        });
        return;
      }

      const leave = openLeaves.shift() ?? nestedLeaves.shift()!;
      rows.push({
        periodKey: `matched:${leave.event_no}`,
        elderId,
        status: LeavePeriodStatus.MATCHED,
        startDate: leave.event_date,
        endDateExclusive: addDays(e.event_date, 1),
        leaveEventId: leave.id,
        returnEventId: e.id,
        leaveEventNo: leave.event_no,
        returnEventNo: e.event_no,
        explanation: `离院 ${leave.event_no} 与返院 ${e.event_no} 配对，按天暂停（含离院日和返院日）`,
      });
    });

    const emitOpenOrNested = (leave: EventRow) => {
      const nested = nestedLeaves.includes(leave);
      rows.push({
        periodKey: `${nested ? 'nested' : 'open'}:${leave.event_no}`,
        elderId,
        status: nested
          ? LeavePeriodStatus.NESTED_DEPARTURE
          : LeavePeriodStatus.OPEN_MISSING_RETURN,
        startDate: leave.event_date,
        endDateExclusive: nested ? addDays(leave.event_date, 1) : null,
        leaveEventId: leave.id,
        leaveEventNo: leave.event_no,
        explanation: nested
          ? `离院事件 ${leave.event_no} 与前一离院重叠且未得到可区分返院，系统不自动嵌套；请人工核对原始事件`
          : `离院事件 ${leave.event_no} 尚缺返院配对；试算仅逐天临时暂停，不按整月停费，结算前必须补齐或人工处理`,
      });
    };
    openLeaves.forEach(emitOpenOrNested);
    nestedLeaves.forEach(emitOpenOrNested);

    for (const row of rows) {
      await manager.save(LeaveSuspensionPeriod, row);
    }
    return manager.find(LeaveSuspensionPeriod, {
      where: { elderId },
      order: { startDate: 'ASC', periodKey: 'ASC' },
    });
  }

  /**
   * 新事件影响已结算月份时，只追加调整单。
   * 原 settlement_lines.billed_amount 永不更新；逐日差额连接新批次，可审计回放。
   */
  private async createSettledMonthAdjustments(
    manager: any,
    elderId: string,
    batchId: string,
  ): Promise<FeeAdjustment[]> {
    const settlements: FeeSettlement[] = await manager.find(FeeSettlement, {
      where: { elderId },
      order: { periodMonth: 'ASC' },
    });
    const created: FeeAdjustment[] = [];

    for (const settlement of settlements) {
      const projection = await this.billingProjection.project(
        manager,
        elderId,
        settlement.monthStart,
        settlement.monthEnd,
        'ADJUST',
      );
      const lines = await manager.find(FeeSettlementLine, {
        where: { settlementId: settlement.id },
        order: { feeDate: 'ASC' },
      });
      const adjustmentLineRows: Array<{
        line: FeeSettlementLine;
        desired: Decimal;
        beforeNet: Decimal;
        delta: Decimal;
        leavePeriodKey: string | null;
      }> = [];

      for (const line of lines) {
        const prior: Array<{ delta_amount: string }> = await manager.query(
          `SELECT COALESCE(SUM(delta_amount),0) AS delta_amount
             FROM fee_adjustment_lines fal
             JOIN fee_adjustments fa ON fa.id = fal.adjustment_id
            WHERE fal.settlement_line_id = $1 AND fa.batch_id <> $2`,
          [line.id, batchId],
        );
        const projectedDay = projection.days.find((d) => d.date === line.feeDate);
        // 以结算时冻结的 originalAmount 为基准，只重算“当天是否暂停”，避免迟到费率变更混入。
        const desired = new Decimal(
          projectedDay?.paused ? 0 : line.originalAmount,
        );
        const beforeNet = new Decimal(line.billedAmount).plus(prior[0].delta_amount);
        const delta = desired.minus(beforeNet);
        if (!delta.isZero()) {
          adjustmentLineRows.push({
            line,
            desired,
            beforeNet,
            delta,
            leavePeriodKey: projectedDay?.leavePeriodKey ?? null,
          });
        }
      }

      if (!adjustmentLineRows.length) continue;
      const amount = adjustmentLineRows.reduce(
        (sum, x) => sum.plus(x.delta),
        new Decimal(0),
      );
      if (amount.isZero()) continue;

      const adjustment = await manager.save(FeeAdjustment, {
        settlementId: settlement.id,
        elderId,
        periodMonth: settlement.periodMonth,
        batchId,
        adjustmentType: amount.isNegative()
          ? FeeAdjustmentType.REFUND
          : FeeAdjustmentType.SUPPLEMENT,
        amount: moneyText(amount),
        reason:
          '迟到/补录离返院事件命中已结算月份；原账保留，按逐日暂停差额追加调整',
      });
      for (const x of adjustmentLineRows) {
        await manager.save(FeeAdjustmentLine, {
          adjustmentId: adjustment.id,
          settlementLineId: x.line.id,
          batchId,
          elderId,
          feeDate: x.line.feeDate,
          beforeBilledAmount: moneyText(x.beforeNet),
          desiredBilledAmount: moneyText(x.desired),
          deltaAmount: moneyText(x.delta),
          leavePeriodKey: x.leavePeriodKey,
        });
      }
      adjustment.lines = await manager.find(FeeAdjustmentLine, {
        where: { adjustmentId: adjustment.id },
        order: { feeDate: 'ASC' },
      });
      created.push(adjustment);
    }

    return created;
  }

  private periodResponse(p: LeaveSuspensionPeriod) {
    return {
      ...p,
      startDate: p.startDate,
      eventDate: p.eventDate,
      endDate: p.endDateExclusive ? addDays(p.endDateExclusive, -1) : (p.eventDate ?? null),
    };
  }
}
