import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { GradeCode } from '../common/enums';
import { addDays, inclusiveDays, isValidDate } from '../common/date.util';
import { moneyText } from '../common/money.util';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import {
  LeavePeriodStatus,
  LeaveSuspensionPeriod,
} from '../entities/leave-suspension-period.entity';

export type ProjectionMode = 'TRIAL' | 'SETTLE' | 'ADJUST';

export interface DailyProjection {
  date: string;
  grade: GradeCode | null;
  dailyRate: string | null;
  rateEffectiveFrom: string | null;
  gradePeriodId: string | null;
  originalAmount: string;
  billedAmount: string;
  paused: boolean;
  leavePeriodKey: string | null;
  leaveStatus: LeavePeriodStatus | null;
}

export interface FeeProjectionSegment {
  startDate: string;
  endDate: string;
  days: number;
  grade: GradeCode | null;
  dailyRate: string | null;
  /** 结算口径应收：暂停日为 0。兼容旧费用接口字段名。 */
  amount: string;
  /** 未应用离院暂停前，按等级/费率应收金额。 */
  originalAmount: string;
  source:
    | 'GRADE_PERIOD_AND_RATE'
    | 'GRADE_PERIOD_NO_RATE'
    | 'NO_EFFECTIVE_GRADE'
    | 'LEAVE_PAUSED';
  status:
    | 'BILLABLE'
    | 'PAUSED_MATCHED'
    | 'PAUSED_OPEN'
    | 'NO_EFFECTIVE_GRADE'
    | 'MISSING_RATE';
  gradePeriodId: string | null;
  rateEffectiveFrom: string | null;
  leavePeriodKey: string | null;
  leaveStatus: LeavePeriodStatus | null;
  warnings: string[];
  note: string;
}

export interface FeeProjection {
  elderId: string;
  from: string;
  to: string;
  totalDays: number;
  originalAmount: string;
  totalAmount: string;
  pausedDays: number;
  days: DailyProjection[];
  segments: FeeProjectionSegment[];
  anomalies: Array<{
    periodKey: string;
    status: LeavePeriodStatus;
    startDate: string | null;
    eventDate: string | null;
    endDateExclusive: string | null;
    explanation: string;
    leaveEventNo: string | null;
    returnEventNo: string | null;
  }>;
}

@Injectable()
export class BillingProjectionService {
  /**
   * 逐天生成账本投影。
   * - TRIAL：未配对离院在查询截止日前临时暂停，状态明确标为 OPEN，不按整月推断；
   * - SETTLE：月结时同样允许 OPEN  provisional 暂停；
   * - ADJUST：迟到事件回算已结算月份，只承认已配对 MATCHED，避免未定离院无限改账。
   */
  async project(
    manager: EntityManager,
    elderId: string,
    from: string,
    to: string,
    mode: ProjectionMode,
  ): Promise<FeeProjection> {
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      throw new Error('INVALID_RANGE:查询区间日期不合法或起止倒置');
    }

    const periods = await manager.find(GradeEffectivePeriod, {
      where: { elderId },
      order: { startDate: 'ASC' },
    });
    const rates = await manager.find(FeeRateVersion, {
      order: { effectiveFrom: 'ASC' },
    });
    const leavePeriods = await manager.find(LeaveSuspensionPeriod, {
      where: { elderId },
      order: { startDate: 'ASC' },
    });

    const days: DailyProjection[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const gradePeriod = periods.find((p) => {
        const end = p.endDateExclusive ?? '9999-12-31';
        return p.startDate <= date && date < end;
      });
      const grade = gradePeriod?.grade ?? null;
      const applicableRates = rates
        .filter((r) => r.grade === grade && r.effectiveFrom <= date)
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
      const rate = applicableRates[0] ?? null;
      const original = grade && rate ? new Decimal(rate.dailyRate) : new Decimal(0);

      const activeLeave = leavePeriods.find((lp) => {
        if (lp.status === LeavePeriodStatus.MATCHED) {
          return (
            lp.startDate !== null &&
            lp.endDateExclusive !== null &&
            lp.startDate <= date &&
            date < lp.endDateExclusive
          );
        }
        if (
          mode !== 'ADJUST' &&
          lp.status === LeavePeriodStatus.OPEN_MISSING_RETURN
        ) {
          return lp.startDate !== null && lp.startDate <= date;
        }
        return false;
      });

      const paused = Boolean(activeLeave);
      days.push({
        date,
        grade,
        dailyRate: rate ? moneyText(rate.dailyRate) : null,
        rateEffectiveFrom: rate?.effectiveFrom ?? null,
        gradePeriodId: gradePeriod?.id ?? null,
        originalAmount: moneyText(original),
        billedAmount: paused ? '0.00' : moneyText(original),
        paused,
        leavePeriodKey: activeLeave?.periodKey ?? null,
        leaveStatus: activeLeave?.status ?? null,
      });
    }

    const segments = this.groupDays(days, leavePeriods);
    const anomalies = leavePeriods
      .filter((lp) => lp.status !== LeavePeriodStatus.MATCHED)
      .filter((lp) => this.intersectsQuery(lp, from, to))
      .map((lp) => ({
        periodKey: lp.periodKey,
        status: lp.status,
        startDate: lp.startDate,
        eventDate: lp.eventDate,
        endDateExclusive: lp.endDateExclusive,
        explanation: lp.explanation,
        leaveEventNo: lp.leaveEventNo,
        returnEventNo: lp.returnEventNo,
      }));

    const originalTotal = days.reduce(
      (sum, d) => sum.plus(d.originalAmount),
      new Decimal(0),
    );
    const billedTotal = days.reduce(
      (sum, d) => sum.plus(d.billedAmount),
      new Decimal(0),
    );

    return {
      elderId,
      from,
      to,
      totalDays: days.length,
      originalAmount: moneyText(originalTotal),
      totalAmount: moneyText(billedTotal),
      pausedDays: days.filter((d) => d.paused).length,
      days,
      segments,
      anomalies,
    };
  }

  private groupDays(
    days: DailyProjection[],
    leavePeriods: LeaveSuspensionPeriod[],
  ): FeeProjectionSegment[] {
    const groups: Array<{ start: number; end: number; key: string }> = [];
    days.forEach((d, i) => {
      const key = [
        d.grade ?? '',
        d.rateEffectiveFrom ?? '',
        d.paused ? d.leavePeriodKey : 'BILLABLE',
        d.leaveStatus ?? '',
      ].join('|');
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.end = i;
      else groups.push({ start: i, end: i, key });
    });

    return groups.map((g) => {
      const first = days[g.start];
      const last = days[g.end];
      const segDays = days.slice(g.start, g.end + 1);
      const count = inclusiveDays(first.date, last.date);
      const originalTotal = segDays.reduce(
        (sum, d) => sum.plus(d.originalAmount),
        new Decimal(0),
      );
      const billedTotal = segDays.reduce(
        (sum, d) => sum.plus(d.billedAmount),
        new Decimal(0),
      );
      const warnings: string[] = [];
      const lp = first.leavePeriodKey
        ? leavePeriods.find((x) => x.periodKey === first.leavePeriodKey)
        : undefined;

      if (lp) {
        const pausedDaySet = days.filter((d) => d.leavePeriodKey === lp.periodKey);
        const grades = new Set(pausedDaySet.map((d) => d.grade ?? ''));
        const rateStarts = new Set(pausedDaySet.map((d) => d.rateEffectiveFrom ?? ''));
        if (grades.size > 1) {
          warnings.push(
            `离院区间 ${lp.leaveEventNo ?? lp.periodKey} 跨等级，仍逐天命中暂停并保留等级分段`,
          );
        }
        if (rateStarts.size > 1) {
          warnings.push(
            `离院区间 ${lp.leaveEventNo ?? lp.periodKey} 跨日费版本，仍逐天命中暂停并保留费率分段`,
          );
        }
        if (lp.status === LeavePeriodStatus.OPEN_MISSING_RETURN) {
          warnings.push('缺少返院配对：当前为临时暂停，补到返院后可重算/调整');
        }
      }
      if (first.grade && !first.dailyRate) {
        warnings.push(`等级 ${first.grade} 在该日期缺少适用日费版本`);
      }

      let source: FeeProjectionSegment['source'];
      let status: FeeProjectionSegment['status'];
      let note: string;
      if (first.paused) {
        source = 'LEAVE_PAUSED';
        status =
          first.leaveStatus === LeavePeriodStatus.MATCHED
            ? 'PAUSED_MATCHED'
            : 'PAUSED_OPEN';
        note = `离院暂停命中 ${count} 天：原费用 ${moneyText(originalTotal)}，本账段应收 0.00`;
      } else if (!first.grade) {
        source = 'NO_EFFECTIVE_GRADE';
        status = 'NO_EFFECTIVE_GRADE';
        note = '无生效等级：不计费';
      } else if (!first.dailyRate) {
        source = 'GRADE_PERIOD_NO_RATE';
        status = 'MISSING_RATE';
        note = `等级 ${first.grade} 已生效但机构示例规则未定义日费：暂不计费`;
      } else {
        source = 'GRADE_PERIOD_AND_RATE';
        status = 'BILLABLE';
        note = `${first.grade} 等级期间 × 日费版本自 ${first.rateEffectiveFrom} 起`;
      }

      return {
        startDate: first.date,
        endDate: last.date,
        days: count,
        grade: first.grade,
        dailyRate: first.dailyRate,
        amount: moneyText(billedTotal),
        originalAmount: moneyText(originalTotal),
        source,
        status,
        gradePeriodId: first.gradePeriodId,
        rateEffectiveFrom: first.rateEffectiveFrom,
        leavePeriodKey: first.leavePeriodKey,
        leaveStatus: first.leaveStatus,
        warnings,
        note,
      };
    });
  }

  private intersectsQuery(
    lp: LeaveSuspensionPeriod,
    from: string,
    to: string,
  ): boolean {
    if (lp.status === LeavePeriodStatus.ORPHAN_RETURN ||
        lp.status === LeavePeriodStatus.RETURN_BEFORE_DEPARTURE) {
      const d = lp.eventDate ?? lp.startDate;
      return d !== null && d >= from && d <= to;
    }
    if (!lp.startDate) return false;
    const end = lp.endDateExclusive ? addDays(lp.endDateExclusive, -1) : to;
    return lp.startDate <= to && end >= from;
  }
}
