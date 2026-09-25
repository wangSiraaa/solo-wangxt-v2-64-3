import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { createHash, randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { LeaveEvent } from '../entities/leave-event.entity';
import { LeavePeriod } from '../entities/leave-period.entity';
import { LeaveAnomaly } from '../entities/leave-anomaly.entity';
import { FeeAdjustment } from '../entities/fee-adjustment.entity';
import { FeeAdjustmentItem } from '../entities/fee-adjustment-item.entity';
import { FeeChargeEntry } from '../entities/fee-charge-entry.entity';
import {
  AdjustmentType,
  LeaveAnomalyType,
  LeaveEventType,
  LeavePeriodStatus,
} from '../common/leave.enums';
import { addDays } from '../common/date.util';
import { RecordLeaveEventDto } from './dto/leave-fee.dto';
import { businessDateInShanghai } from '../common/business-date.util';
import { moneyText } from '../common/money.util';

interface EventRow {
  event_id: string;
  elder_id: string;
  event_type: LeaveEventType;
  occurred_at: Date;
  received_seq: string;
  batch_id: string;
  payload_hash: string;
  raw_payload: Record<string, unknown>;
}

export interface MaterializedPeriod {
  departureEventId: string;
  returnEventId: string | null;
  elderId: string;
  status: LeavePeriodStatus;
  startDate: string;
  endDateExclusive: string | null;
  departureOccurredAt: Date;
  returnOccurredAt: Date | null;
  departureReceivedSeq: number;
  returnReceivedSeq: number | null;
  statusReason: string;
}

export interface MaterializedAnomaly {
  elderId: string;
  anomalyType: LeaveAnomalyType;
  departureEventId: string | null;
  returnEventId: string | null;
  occurredDate: string | null;
  reason: string;
}

interface MaterializationResult {
  periods: MaterializedPeriod[];
  anomalies: MaterializedAnomaly[];
}

export interface AdjustmentReplay {
  adjustment: FeeAdjustment;
  items: FeeAdjustmentItem[];
  replayed: boolean;
}

@Injectable()
export class LeaveLedgerService {
  constructor(
    @InjectRepository(LeaveEvent)
    private readonly eventRepo: Repository<LeaveEvent>,
    @InjectRepository(LeavePeriod)
    private readonly periodRepo: Repository<LeavePeriod>,
    @InjectRepository(LeaveAnomaly)
    private readonly anomalyRepo: Repository<LeaveAnomaly>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 录入一批离返院事件。同一老人的事件历史在一个事务内锁定、归并、物化，
   * 任何重复号冲突或约束冲突都会整批回滚，不留下半个暂停区间。
   */
  async recordEvents(inputs: RecordLeaveEventDto[]) {
    const uniqueInputs = new Map<string, RecordLeaveEventDto>();
    for (const input of inputs) {
      const previous = uniqueInputs.get(input.eventId);
      if (previous && this.payloadHash(previous) !== this.payloadHash(input)) {
        throw new ConflictException({
          code: 'STABLE_EVENT_CONFLICT',
          message: `同一批次中的稳定事件号 ${input.eventId} 携带了不同事实`,
        });
      }
      uniqueInputs.set(input.eventId, previous ?? input);
    }

    const events = [...uniqueInputs.values()];
    const elderIds = new Set(events.map((e) => e.elderId));
    if (elderIds.size !== 1) {
      throw new ConflictException({
        code: 'MIXED_ELDERS_IN_BATCH',
        message: '一个离返院事件批次只能属于同一位老人，避免跨老人账本产生半成功状态',
      });
    }
    const elderId = events[0].elderId;

    const seqInBatch = new Set<number>();
    for (const e of events) {
      if (seqInBatch.has(e.receivedSeq)) {
        throw new ConflictException({
          code: 'RECEIVED_SEQ_CONFLICT',
          message: `同一批次中接收顺序 ${e.receivedSeq} 重复`,
        });
      }
      seqInBatch.add(e.receivedSeq);
    }

    const batchId = randomUUID();

    return this.dataSource.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [elderId]);

      let insertedCount = 0;
      let duplicateCount = 0;

      for (const input of events) {
        const hash = this.payloadHash(input);
        const existing = await em.findOne(LeaveEvent, {
          where: { eventId: input.eventId },
        });

        if (existing) {
          if (
            existing.elderId !== input.elderId ||
            existing.eventType !== input.eventType ||
            existing.payloadHash !== hash
          ) {
            throw new ConflictException({
              code: 'STABLE_EVENT_CONFLICT',
              message: `稳定事件号 ${input.eventId} 已存在且事实不一致；事件账本不可覆盖`,
              existingEventId: existing.eventId,
            });
          }
          duplicateCount += 1;
          continue;
        }

        const seqConflict = await em.findOne(LeaveEvent, {
          where: { elderId: input.elderId, receivedSeq: String(input.receivedSeq) },
        });
        if (seqConflict) {
          throw new ConflictException({
            code: 'RECEIVED_SEQ_CONFLICT',
            message: `老人 ${input.elderId} 的接收顺序 ${input.receivedSeq} 已被事件 ${seqConflict.eventId} 占用`,
          });
        }

        const entity = new LeaveEvent();
        entity.eventId = input.eventId;
        entity.elderId = input.elderId;
        entity.eventType = input.eventType;
        entity.occurredAt = new Date(input.occurredAt);
        entity.receivedSeq = String(input.receivedSeq);
        entity.batchId = batchId;
        entity.payloadHash = hash;
        entity.rawPayload = { ...input };
        await em.save(entity);
        insertedCount += 1;
      }

      const rows = await em.query<EventRow[]>(
        `SELECT event_id, elder_id, event_type, occurred_at, received_seq,
                batch_id, payload_hash, raw_payload
           FROM leave_events
          WHERE elder_id = $1
          ORDER BY occurred_at ASC, received_seq ASC, event_id ASC`,
        [elderId],
      );

      const materialized = this.materialize(rows);
      await this.replaceMaterialization(em, elderId, materialized, batchId);

      const adjustments = insertedCount
        ? await this.createAdjustmentsForNewEvents(
            em,
            materialized.periods,
            new Set(events.map((e) => e.eventId)),
            batchId,
          )
        : [];

      return {
        replayed: insertedCount === 0,
        batchId,
        insertedCount,
        duplicateCount,
        periods: materialized.periods,
        anomalies: materialized.anomalies,
        adjustments,
      };
    });
  }

  async listEvents(elderId: string): Promise<LeaveEvent[]> {
    return this.eventRepo.find({
      where: { elderId },
      order: { occurredAt: 'ASC', receivedSeq: 'ASC' },
    });
  }

  async listPeriods(elderId: string): Promise<{
    periods: LeavePeriod[];
    anomalies: LeaveAnomaly[];
  }> {
    const [periods, anomalies] = await Promise.all([
      this.periodRepo.find({
        where: { elderId },
        order: { startDate: 'ASC', departureReceivedSeq: 'ASC' },
      }),
      this.anomalyRepo.find({
        where: { elderId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return { periods, anomalies };
  }

  /**
   * 纯归并算法：按发生时间配对，按接收顺序打破同刻并列。
   * 返院先到、离院后补也能在完整历史中得到唯一区间；
   * 重叠离院、孤立返院等事实不产生暂停区间，只落可解释状态。
   */
  materialize(rows: EventRow[]): MaterializationResult {
    const elderId = rows[0]?.elder_id ?? '';
    const departures = rows
      .filter((r) => r.event_type === LeaveEventType.DEPARTURE)
      .sort(compareEvent);
    const returns = rows
      .filter((r) => r.event_type === LeaveEventType.RETURN)
      .sort(compareEvent);

    const assignment = new Map<string, EventRow>();
    const matchedReturnIds = new Set<string>();

    for (const ret of returns) {
      const candidate = departures
        .filter(
          (dep) =>
            !assignment.has(dep.event_id) &&
            dep.occurred_at.getTime() <= ret.occurred_at.getTime(),
        )
        .sort(compareEvent)[0];
      if (candidate) {
        assignment.set(candidate.event_id, ret);
        matchedReturnIds.add(ret.event_id);
      }
    }

    const overlapping = this.findOverlappingDepartures(departures, assignment);
    const periods: MaterializedPeriod[] = [];

    for (const dep of departures) {
      const ret = assignment.get(dep.event_id) ?? null;
      const startDate = businessDateInShanghai(dep.occurred_at);

      if (overlapping.has(dep.event_id)) {
        periods.push({
          departureEventId: dep.event_id,
          returnEventId: ret?.event_id ?? null,
          elderId,
          status: LeavePeriodStatus.OVERLAPPING_DEPARTURE,
          startDate,
          endDateExclusive: ret
            ? addDays(businessDateInShanghai(ret.occurred_at), 1)
            : null,
          departureOccurredAt: dep.occurred_at,
          returnOccurredAt: ret?.occurred_at ?? null,
          departureReceivedSeq: Number(dep.received_seq),
          returnReceivedSeq: ret ? Number(ret.received_seq) : null,
          statusReason:
            '存在相互重叠的离院事件，已暂停自动计费判断，需人工核对真实离返院边界',
        });
        continue;
      }

      if (!ret) {
        periods.push({
          departureEventId: dep.event_id,
          returnEventId: null,
          elderId,
          status: LeavePeriodStatus.AWAITING_RETURN,
          startDate,
          endDateExclusive: null,
          departureOccurredAt: dep.occurred_at,
          returnOccurredAt: null,
          departureReceivedSeq: Number(dep.received_seq),
          returnReceivedSeq: null,
          statusReason:
            '缺少配对返院事件：不能按整月停费；补录前试算/结算均按在院护理费用处理',
        });
        continue;
      }

      periods.push({
        departureEventId: dep.event_id,
        returnEventId: ret.event_id,
        elderId,
        status: LeavePeriodStatus.MATCHED,
        startDate,
        endDateExclusive: addDays(businessDateInShanghai(ret.occurred_at), 1),
        departureOccurredAt: dep.occurred_at,
        returnOccurredAt: ret.occurred_at,
        departureReceivedSeq: Number(dep.received_seq),
        returnReceivedSeq: Number(ret.received_seq),
        statusReason: '离院与返院事件按发生时间唯一配对，暂停闭区间内逐日护理费用',
      });
    }

    const anomalies: MaterializedAnomaly[] = [];
    for (const dep of departures.filter((d) => overlapping.has(d.event_id))) {
      anomalies.push({
        elderId,
        anomalyType: LeaveAnomalyType.OVERLAPPING_DEPARTURE,
        departureEventId: dep.event_id,
        returnEventId: assignment.get(dep.event_id)?.event_id ?? null,
        occurredDate: businessDateInShanghai(dep.occurred_at),
        reason: '该离院事件与其他离院期间重叠，未物化暂停区间',
      });
    }

    for (const ret of returns.filter((r) => !matchedReturnIds.has(r.event_id))) {
      const laterDeparture = departures
        .filter((d) => d.occurred_at.getTime() > ret.occurred_at.getTime())
        .sort(compareEvent)[0];
      anomalies.push({
        elderId,
        anomalyType: laterDeparture
          ? LeaveAnomalyType.RETURN_BEFORE_DEPARTURE
          : LeaveAnomalyType.ORPHAN_RETURN,
        departureEventId: laterDeparture?.event_id ?? null,
        returnEventId: ret.event_id,
        occurredDate: businessDateInShanghai(ret.occurred_at),
        reason: laterDeparture
          ? `返院时间早于最近的后续离院事件 ${laterDeparture.event_id}，不产生暂停区间`
          : '返院事件缺少可配对的在先离院事件，不产生暂停区间',
      });
    }

    return { periods, anomalies };
  }

  /**
   * 依据本批事件影响的日期范围，只对已结算账目做追加式核对。
   * 原 fee_charge_entries 永不更新；有差额才生成 REFUND/SURCHARGE 调整单。
   */
  private async createAdjustmentsForNewEvents(
    em: EntityManager,
    currentPeriods: MaterializedPeriod[],
    newEventIds: Set<string>,
    sourceBatchId: string,
  ): Promise<AdjustmentReplay[]> {
    const affectedRanges = currentPeriods
      .filter(
        (p) =>
          newEventIds.has(p.departureEventId) ||
          (p.returnEventId && newEventIds.has(p.returnEventId)),
      )
      .map((p) => ({
        start: p.startDate,
        end: p.endDateExclusive ? addDays(p.endDateExclusive, -1) : '9999-12-31',
      }));

    if (!affectedRanges.length) return [];

    const minStart = affectedRanges.map((r) => r.start).sort()[0];
    const elderId = currentPeriods[0]?.elderId;
    if (!elderId) return [];

    const allSettlements = await em.query<{ id: string }[]>(
      `SELECT id FROM fee_settlements WHERE elder_id = $1 AND to_date >= $2`,
      [elderId, minStart],
    );
    const settlementIds = allSettlements.map((s) => s.id);
    if (!settlementIds.length) return [];

    const entries = await em.query<Array<{
      id: string;
      settlement_id: string;
      elder_id: string;
      entry_date: string;
      base_amount: string;
      net_amount: string;
      leave_period_departure_event_id: string | null;
    }>>(
      `SELECT id, settlement_id, elder_id, entry_date::text AS entry_date,
              base_amount, net_amount, leave_period_departure_event_id
         FROM fee_charge_entries
        WHERE settlement_id = ANY($1)
        ORDER BY entry_date, id`,
      [settlementIds],
    );

    const matched = currentPeriods.filter(
      (p) => p.status === LeavePeriodStatus.MATCHED,
    );
    const groups = new Map<
      string,
      {
        elderId: string;
        items: Array<{
          chargeEntryId: string;
          entryDate: string;
          originalAmount: string;
          correctedAmount: string;
          deltaAmount: Decimal;
          departureEventId: string;
          returnEventId: string | null;
        }>;
        eventIds: Set<string>;
      }
    >();

    for (const entry of entries) {
      const inAffectedRange = affectedRanges.some(
        (r) => entry.entry_date >= r.start && entry.entry_date <= r.end,
      );
      if (!inAffectedRange) continue;

      const currentPause = matched.find(
        (p) =>
          p.startDate <= entry.entry_date &&
          (!p.endDateExclusive || entry.entry_date < p.endDateExclusive),
      );
      const correctedAmount = currentPause ? '0.00' : moneyText(entry.base_amount);
      const delta = new Decimal(correctedAmount).minus(entry.net_amount);
      if (delta.isZero()) continue;

      const sourceDeparture =
        currentPause?.departureEventId ??
        entry.leave_period_departure_event_id;
      if (!sourceDeparture) continue;

      const sourcePeriod =
        currentPause ??
        currentPeriods.find((p) => p.departureEventId === sourceDeparture);
          const existingItem = await em.findOne(FeeAdjustmentItem, {
            where: {
              chargeEntryId: entry.id,
              departureEventId: sourceDeparture,
              returnEventId: sourcePeriod?.returnEventId ?? IsNull(),
              sourceBatchId,
            },
          });
          if (existingItem) continue;

          const group =
            groups.get(entry.settlement_id) ??
        {
          elderId: entry.elder_id,
          items: [],
          eventIds: new Set<string>(),
        };
      group.items.push({
        chargeEntryId: entry.id,
        entryDate: entry.entry_date,
        originalAmount: moneyText(entry.net_amount),
        correctedAmount,
        deltaAmount: delta,
        departureEventId: sourceDeparture,
        returnEventId:
          currentPause?.returnEventId ?? sourcePeriod?.returnEventId ?? null,
      });
      group.eventIds.add(sourceDeparture);
      if (sourcePeriod?.returnEventId) group.eventIds.add(sourcePeriod.returnEventId);
      groups.set(entry.settlement_id, group);
    }

    const result: AdjustmentReplay[] = [];
    for (const [settlementId, group] of groups) {
      const amount = group.items.reduce(
        (sum, item) => sum.plus(item.deltaAmount),
        new Decimal(0),
      );
      if (amount.isZero()) continue;

      const existing = await em.findOne(FeeAdjustment, {
        where: { sourceBatchId, settlementId },
      });
      if (existing) {
        const items = await em.find(FeeAdjustmentItem, {
          where: { adjustmentId: existing.id },
          order: { entryDate: 'ASC' },
        });
        result.push({ adjustment: existing, items, replayed: true });
        continue;
      }

      const adjustment = new FeeAdjustment();
      adjustment.elderId = group.elderId;
      adjustment.settlementId = settlementId;
      adjustment.adjustmentType =
        amount.isNegative()
          ? AdjustmentType.REFUND
          : AdjustmentType.SURCHARGE;
      adjustment.amount = amount.abs().toFixed(2);
      adjustment.reason =
        amount.isNegative()
          ? '迟到离院事件命中已结算期间：追加暂停护理费用退费调整'
          : '迟到事件修正暂停状态：追加护理费用补收调整';
      adjustment.sourceBatchId = sourceBatchId;
      adjustment.sourceEventIds = [...group.eventIds];
      await em.save(adjustment);

      const savedItems: FeeAdjustmentItem[] = [];
      for (const item of group.items) {
        const entity = new FeeAdjustmentItem();
        entity.adjustmentId = adjustment.id;
        entity.chargeEntryId = item.chargeEntryId;
        entity.elderId = group.elderId;
        entity.entryDate = item.entryDate;
        entity.originalAmount = item.originalAmount;
        entity.correctedAmount = item.correctedAmount;
        entity.deltaAmount = item.deltaAmount.toFixed(2);
        entity.departureEventId = item.departureEventId;
        entity.returnEventId = item.returnEventId;
        entity.sourceBatchId = sourceBatchId;
        await em.save(entity);
        savedItems.push(entity);
      }
      result.push({ adjustment, items: savedItems, replayed: false });
    }

    return result;
  }

  private findOverlappingDepartures(
    departures: EventRow[],
    assignment: Map<string, EventRow>,
  ): Set<string> {
    const overlapping = new Set<string>();
    const withEnd = departures.map((d) => {
      const ret = assignment.get(d.event_id);
      return {
        event: d,
        start: businessDateInShanghai(d.occurred_at),
        endExclusive: ret
          ? addDays(businessDateInShanghai(ret.occurred_at), 1)
          : null,
      };
    });

    for (let i = 0; i < withEnd.length; i++) {
      for (let j = i + 1; j < withEnd.length; j++) {
        const a = withEnd[i];
        const b = withEnd[j];
        const aEnd = a.endExclusive ?? '9999-12-31';
        const bEnd = b.endExclusive ?? '9999-12-31';
        if (a.start < bEnd && b.start < aEnd) {
          overlapping.add(a.event.event_id);
          overlapping.add(b.event.event_id);
        }
      }
    }
    return overlapping;
  }

  private async replaceMaterialization(
    em: EntityManager,
    elderId: string,
    result: MaterializationResult,
    batchId: string,
  ): Promise<void> {
    await em.query('DELETE FROM leave_anomalies WHERE elder_id = $1', [elderId]);
    await em.query('DELETE FROM leave_periods WHERE elder_id = $1', [elderId]);

    for (const p of result.periods) {
      const entity = new LeavePeriod();
      Object.assign(entity, {
        departureEventId: p.departureEventId,
        returnEventId: p.returnEventId,
        elderId: p.elderId,
        status: p.status,
        startDate: p.startDate,
        endDateExclusive: p.endDateExclusive,
        departureOccurredAt: p.departureOccurredAt,
        returnOccurredAt: p.returnOccurredAt,
        departureReceivedSeq: String(p.departureReceivedSeq),
        returnReceivedSeq:
          p.returnReceivedSeq === null ? null : String(p.returnReceivedSeq),
        statusReason: p.statusReason,
        materializedBatchId: batchId,
      });
      await em.save(entity);
    }

    for (const a of result.anomalies) {
      const entity = new LeaveAnomaly();
      Object.assign(entity, a);
      await em.save(entity);
    }
  }

  private payloadHash(input: RecordLeaveEventDto): string {
    const canonical = JSON.stringify({
      elderId: input.elderId,
      eventType: input.eventType,
      occurredAt: input.occurredAt,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }
}

function compareEvent(a: EventRow, b: EventRow): number {
  const time = a.occurred_at.getTime() - b.occurred_at.getTime();
  if (time) return time;
  const seq = Number(a.received_seq) - Number(b.received_seq);
  if (seq) return seq;
  return a.event_id.localeCompare(b.event_id);
}
