import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { LeavePeriod } from '../entities/leave-period.entity';
import { LeaveAnomaly } from '../entities/leave-anomaly.entity';
import { FeeSettlement } from '../entities/fee-settlement.entity';
import { FeeChargeEntry } from '../entities/fee-charge-entry.entity';
import { FeeAdjustment } from '../entities/fee-adjustment.entity';
import { FeeAdjustmentItem } from '../entities/fee-adjustment-item.entity';
import {
  FeeLineStatus,
  LeavePeriodStatus,
} from '../common/leave.enums';
import {
  addDays,
  inclusiveDays,
  isValidDate,
} from '../common/date.util';
import { dailyTimesRate, moneyText } from '../common/money.util';
import { GradeCode } from '../common/enums';

interface DailyFeeLine {
  date: string;
  status: FeeLineStatus;
  grade: GradeCode | null;
  gradePeriodId: string | null;
  rateVersionId: string | null;
  dailyRate: string | null;
  baseAmount: Decimal;
  pausedAmount: Decimal;
  netAmount: Decimal;
  leavePeriodDepartureEventId: string | null;
  leavePeriodReturnEventId: string | null;
  note: string;
}

export interface LeaveFeeSegment {
  startDate: string;
  endDate: string;
  days: number;
  status: FeeLineStatus;
  grade: GradeCode | null;
  dailyRate: string | null;
  baseAmount: string;
  pausedAmount: string;
  netAmount: string;
  gradePeriodId: string | null;
  rateVersionId: string | null;
  leavePeriodDepartureEventId: string | null;
  leavePeriodReturnEventId: string | null;
  note: string;
}

export interface LeaveTrialResult {
  elderId: string;
  from: string;
  to: string;
  totalDays: number;
  baseAmount: string;
  pausedAmount: string;
  netAmount: string;
  pausedDays: number;
  billedDays: number;
  noGradeDays: number;
  segments: LeaveFeeSegment[];
  periods: LeavePeriod[];
  anomalies: LeaveAnomaly[];
  notices: string[];
}

@Injectable()
export class LeaveFeesService {
  constructor(
    @InjectRepository(GradeEffectivePeriod)
    private readonly gradeRepo: Repository<GradeEffectivePeriod>,
    @InjectRepository(FeeRateVersion)
    private readonly rateRepo: Repository<FeeRateVersion>,
    @InjectRepository(LeavePeriod)
    private readonly leavePeriodRepo: Repository<LeavePeriod>,
    @InjectRepository(LeaveAnomaly)
    private readonly anomalyRepo: Repository<LeaveAnomaly>,
    @InjectRepository(FeeSettlement)
    private readonly settlementRepo: Repository<FeeSettlement>,
    @InjectRepository(FeeChargeEntry)
    private readonly chargeEntryRepo: Repository<FeeChargeEntry>,
    @InjectRepository(FeeAdjustment)
    private readonly adjustmentRepo: Repository<FeeAdjustment>,
    @InjectRepository(FeeAdjustmentItem)
    private readonly adjustmentItemRepo: Repository<FeeAdjustmentItem>,
    private readonly dataSource: DataSource,
  ) {}

  async trial(elderId: string, from: string, to: string): Promise<LeaveTrialResult> {
    this.validateRange(from, to);
    return this.dataSource.transaction(async (em) => {
      const built = await this.buildTrial(em, elderId, from, to);
      return built;
    });
  }

  async settle(
    elderId: string,
    from: string,
    to: string,
    idempotencyKey?: string,
  ) {
    this.validateRange(from, to);

    return this.dataSource.transaction(async (em) => {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [elderId]);

      if (idempotencyKey) {
        const existing = await em.findOne(FeeSettlement, {
          where: { elderId, idempotencyKey },
        });
        if (existing) {
          const [entries, adjustments] = await Promise.all([
            em.find(FeeChargeEntry, {
              where: { settlementId: existing.id },
              order: { entryDate: 'ASC' },
            }),
            em.find(FeeAdjustment, {
              where: { settlementId: existing.id },
              order: { createdAt: 'ASC' },
            }),
          ]);
          return {
            replayed: true,
            settlement: existing,
            entries,
            adjustments,
            notices: this.extractNotices(existing.ledgerSnapshot),
          };
        }
      }

      const overlaps = await em.query<{ id: string }[]>(
        `SELECT id FROM fee_settlements
          WHERE elder_id = $1
            AND daterange(from_date, to_date, '[]') && daterange($2, $3, '[]')`,
        [elderId, from, to],
      );
      if (overlaps.length) {
        throw new ConflictException({
          code: 'SETTLEMENT_RANGE_OVERLAP',
          message: '结算日期范围与已有已结算账目重叠；请使用调整单修正历史费用',
          existingSettlementIds: overlaps.map((x) => x.id),
        });
      }

      const trial = await this.buildTrial(em, elderId, from, to);
      const settlement = new FeeSettlement();
      settlement.elderId = elderId;
      settlement.fromDate = from;
      settlement.toDate = to;
      settlement.baseAmount = trial.baseAmount;
      settlement.pausedAmount = trial.pausedAmount;
      settlement.netAmount = trial.netAmount;
      settlement.totalDays = trial.totalDays;
      settlement.idempotencyKey = idempotencyKey ?? null;
      settlement.ledgerSnapshot = {
        segments: trial.segments,
        periods: trial.periods,
        anomalies: trial.anomalies,
        notices: trial.notices,
        generatedAt: new Date().toISOString(),
      };
      await em.save(settlement);

      const lines = await this.buildDailyLines(em, elderId, from, to);
      const entries: FeeChargeEntry[] = [];
      for (const line of lines) {
        const entry = new FeeChargeEntry();
        entry.settlementId = settlement.id;
        entry.elderId = elderId;
        entry.entryDate = line.date;
        entry.status = line.status;
        entry.grade = line.grade;
        entry.dailyRate = line.dailyRate;
        entry.baseAmount = line.baseAmount.toFixed(2);
        entry.pausedAmount = line.pausedAmount.toFixed(2);
        entry.netAmount = line.netAmount.toFixed(2);
        entry.gradePeriodId = line.gradePeriodId;
        entry.rateVersionId = line.rateVersionId;
        entry.leavePeriodDepartureEventId = line.leavePeriodDepartureEventId;
        entry.source = {
          note: line.note,
          leavePeriodReturnEventId: line.leavePeriodReturnEventId,
        };
        await em.save(entry);
        entries.push(entry);
      }

      return {
        replayed: false,
        settlement,
        entries,
        adjustments: [],
        notices: trial.notices,
      };
    });
  }

  async listSettlements(elderId: string) {
    return this.settlementRepo.find({
      where: { elderId },
      order: { fromDate: 'DESC' },
    });
  }

  async getSettlement(id: string) {
    const settlement = await this.settlementRepo.findOne({ where: { id } });
    if (!settlement) throw new NotFoundException('结算单不存在');
    const [entries, adjustmentRows, adjustmentItemRows] = await Promise.all([
      this.chargeEntryRepo.find({
        where: { settlementId: id },
        order: { entryDate: 'ASC' },
      }),
      this.adjustmentRepo.find({
        where: { settlementId: id },
        order: { createdAt: 'ASC' },
      }),
      this.adjustmentItemRepo.find({ order: { entryDate: 'ASC' } }),
    ]);
    const adjustments = adjustmentRows.map((adjustment) => ({
      ...adjustment,
      items: adjustmentItemRows.filter((item) => item.adjustmentId === adjustment.id),
    }));
    return {
      settlement,
      entries,
      adjustments,
      notices: this.extractNotices(settlement.ledgerSnapshot),
    };
  }

  async listAdjustments(elderId: string, settlementId?: string) {
    const where = { elderId, ...(settlementId ? { settlementId } : {}) };
    const adjustments = await this.adjustmentRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
    const adjustmentIds = adjustments.map((x) => x.id);
    const items = adjustmentIds.length
      ? await this.adjustmentItemRepo.find({
          where: { adjustmentId: In(adjustmentIds) },
          order: { entryDate: 'ASC' },
        })
      : [];
    return adjustments.map((adjustment) => ({
      adjustment,
      items: items.filter((item) => item.adjustmentId === adjustment.id),
    }));
  }

  private async buildTrial(
    em: EntityManager,
    elderId: string,
    from: string,
    to: string,
  ): Promise<LeaveTrialResult> {
    const [lines, periods, anomalies] = await Promise.all([
      this.buildDailyLines(em, elderId, from, to),
      em.find(LeavePeriod, {
        where: { elderId },
        order: { startDate: 'ASC', departureReceivedSeq: 'ASC' },
      }),
      em.find(LeaveAnomaly, { where: { elderId } }),
    ]);

    const segments = this.mergeDailyLines(lines);
    const totals = lines.reduce(
      (acc, line) => ({
        base: acc.base.plus(line.baseAmount),
        paused: acc.paused.plus(line.pausedAmount),
        net: acc.net.plus(line.netAmount),
      }),
      { base: new Decimal(0), paused: new Decimal(0), net: new Decimal(0) },
    );

    return {
      elderId,
      from,
      to,
      totalDays: inclusiveDays(from, to),
      baseAmount: totals.base.toFixed(2),
      pausedAmount: totals.paused.toFixed(2),
      netAmount: totals.net.toFixed(2),
      pausedDays: lines.filter((x) => x.status === FeeLineStatus.PAUSED).length,
      billedDays: lines
        .filter((x) => x.status !== FeeLineStatus.NO_EFFECTIVE_GRADE && x.netAmount.gt(0))
        .length,
      noGradeDays: lines.filter((x) => x.status === FeeLineStatus.NO_EFFECTIVE_GRADE)
        .length,
      segments,
      periods,
      anomalies,
      notices: this.buildNotices(from, to, lines, periods, anomalies),
    };
  }

  private async buildDailyLines(
    em: EntityManager,
    elderId: string,
    from: string,
    to: string,
  ): Promise<DailyFeeLine[]> {
    const [gradePeriods, rateVersions, matchedLeavePeriods, awaitingPeriods] =
      await Promise.all([
        em.query<Array<{
          id: string;
          grade: GradeCode;
          start_date: string;
          end_date_exclusive: string | null;
        }>>(
          `SELECT id, grade, start_date::text AS start_date,
                  end_date_exclusive::text AS end_date_exclusive
             FROM grade_periods
            WHERE elder_id = $1
            ORDER BY start_date`,
          [elderId],
        ),
        em.find(FeeRateVersion),
        em.find(LeavePeriod, {
          where: { elderId, status: LeavePeriodStatus.MATCHED },
        }),
        em.find(LeavePeriod, {
          where: { elderId, status: LeavePeriodStatus.AWAITING_RETURN },
        }),
      ]);

    const lines: DailyFeeLine[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const gradePeriod = gradePeriods.find(
        (p) =>
          p.start_date <= date &&
          (!p.end_date_exclusive || date < p.end_date_exclusive),
      );
      const rate = gradePeriod
        ? rateVersions
            .filter((r) => r.grade === gradePeriod.grade && r.effectiveFrom <= date)
            .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]
        : undefined;

      const pause = matchedLeavePeriods.find(
        (p) => p.startDate <= date && (!p.endDateExclusive || date < p.endDateExclusive),
      );
      const awaiting = awaitingPeriods.find((p) => p.startDate <= date);

      const dailyRate = rate ? moneyText(rate.dailyRate) : null;
      const base = gradePeriod && rate
        ? dailyTimesRate(rate.dailyRate, 1)
        : new Decimal(0);

      if (!gradePeriod) {
        lines.push({
          date,
          status: FeeLineStatus.NO_EFFECTIVE_GRADE,
          grade: null,
          gradePeriodId: null,
          rateVersionId: null,
          dailyRate: null,
          baseAmount: new Decimal(0),
          pausedAmount: new Decimal(0),
          netAmount: new Decimal(0),
          leavePeriodDepartureEventId: null,
          leavePeriodReturnEventId: null,
          note: '无生效等级：护理费用为 0，离院暂停不额外产生金额',
        });
        continue;
      }

      if (pause) {
        lines.push({
          date,
          status: FeeLineStatus.PAUSED,
          grade: gradePeriod.grade,
          gradePeriodId: gradePeriod.id,
          rateVersionId: rate?.id ?? null,
          dailyRate,
          baseAmount: base,
          pausedAmount: base,
          netAmount: new Decimal(0),
          leavePeriodDepartureEventId: pause.departureEventId,
          leavePeriodReturnEventId: pause.returnEventId,
          note: `命中离院暂停区间 ${pause.departureEventId}→${pause.returnEventId ?? ''}，仅暂停当日护理费用`,
        });
        continue;
      }

      lines.push({
        date,
        // 未配对不是可暂停事实：原费用仍按在院 ACTIVE 落账，风险通过 notice 解释
        status: FeeLineStatus.ACTIVE,
        grade: gradePeriod.grade,
        gradePeriodId: gradePeriod.id,
        rateVersionId: rate?.id ?? null,
        dailyRate,
        baseAmount: base,
        pausedAmount: new Decimal(0),
        netAmount: base,
        leavePeriodDepartureEventId: awaiting?.departureEventId ?? null,
        leavePeriodReturnEventId: null,
        note: awaiting
          ? `离院事件 ${awaiting.departureEventId} 缺少返院配对；未按整月停费，暂按在院试算并提示风险`
          : rate
            ? '在院护理日，按等级期间和费率版本计费'
            : `等级 ${gradePeriod.grade} 当日无可用费率版本，金额暂为 0`,
      });
    }
    return lines;
  }

  private mergeDailyLines(lines: DailyFeeLine[]): LeaveFeeSegment[] {
    const segments: LeaveFeeSegment[] = [];
    let start: DailyFeeLine | null = null;
    let previous: DailyFeeLine | null = null;
    let group: DailyFeeLine[] = [];

    const sameGroup = (a: DailyFeeLine, b: DailyFeeLine) =>
      a.status === b.status &&
      a.grade === b.grade &&
      a.rateVersionId === b.rateVersionId &&
      a.gradePeriodId === b.gradePeriodId &&
      a.dailyRate === b.dailyRate &&
      a.leavePeriodDepartureEventId === b.leavePeriodDepartureEventId;

    const flush = () => {
      if (!start || !previous) return;
      const days = group.length;
      const base = group.reduce((s, x) => s.plus(x.baseAmount), new Decimal(0));
      const paused = group.reduce((s, x) => s.plus(x.pausedAmount), new Decimal(0));
      const net = group.reduce((s, x) => s.plus(x.netAmount), new Decimal(0));
      segments.push({
        startDate: start.date,
        endDate: previous.date,
        days,
        status: start.status,
        grade: start.grade,
        dailyRate: start.dailyRate,
        baseAmount: base.toFixed(2),
        pausedAmount: paused.toFixed(2),
        netAmount: net.toFixed(2),
        gradePeriodId: start.gradePeriodId,
        rateVersionId: start.rateVersionId,
        leavePeriodDepartureEventId: start.leavePeriodDepartureEventId,
        leavePeriodReturnEventId: start.leavePeriodReturnEventId,
        note: start.note,
      });
    };

    for (const line of lines) {
      if (!start || !previous || !sameGroup(previous, line)) {
        flush();
        start = line;
        group = [];
      }
      group.push(line);
      previous = line;
    }
    flush();
    return segments;
  }

  private buildNotices(
    from: string,
    to: string,
    lines: DailyFeeLine[],
    periods: LeavePeriod[],
    anomalies: LeaveAnomaly[],
  ): string[] {
    const notices = new Set<string>();

    if (periods.some((p) => p.status === LeavePeriodStatus.AWAITING_RETURN)) {
      notices.add('存在缺少返院配对的离院事件：不按整月停费，未配对日期仍按在院费用试算/结算');
    }
    if (lines.some((x) => x.status === FeeLineStatus.AWAITING_RETURN)) {
      notices.add('存在缺少返院配对的离院事件：不按整月停费，未配对日期仍按在院费用试算/结算');
    }
    for (const anomaly of anomalies) {
      notices.add(`离返院账本异常 ${anomaly.anomalyType}：${anomaly.reason}`);
    }
    for (const period of periods.filter((p) => p.status === LeavePeriodStatus.MATCHED)) {
      const start = period.startDate < from ? from : period.startDate;
      const inclusiveEnd = period.endDateExclusive
        ? addDays(period.endDateExclusive, -1)
        : to;
      const end = inclusiveEnd > to ? to : inclusiveEnd;
      if (start > end) continue;

      const grades = new Set(
        lines
          .filter((x) => x.date >= start && x.date <= end)
          .map((x) => x.grade ?? 'NO_GRADE'),
      );
      if (grades.size > 1) {
        notices.add(
          `暂停区间 ${period.departureEventId} 跨等级：仍逐日命中暂停，等级分段完整保留`,
        );
      }
      const rates = new Set(
        lines
          .filter((x) => x.date >= start && x.date <= end)
          .map((x) => x.rateVersionId ?? 'NO_RATE'),
      );
      if (rates.size > 1) {
        notices.add(
          `暂停区间 ${period.departureEventId} 跨费率版本：按命中日逐日暂停，不做整月停费`,
        );
      }
    }

    return [...notices];
  }

  private validateRange(from: string, to: string) {
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      throw new ConflictException({
        code: 'INVALID_RANGE',
        message: '查询/结算区间日期不合法或起止倒置',
      });
    }
  }

  private extractNotices(snapshot: unknown): string[] {
    if (
      snapshot &&
      typeof snapshot === 'object' &&
      Array.isArray((snapshot as { notices?: unknown }).notices)
    ) {
      return (snapshot as { notices: string[] }).notices;
    }
    return [];
  }
}
