import { DataSource, DataSourceOptions } from 'typeorm';
import { ScaleVersion } from '../entities/scale-version.entity';
import { ScaleItem } from '../entities/scale-item.entity';
import { ScaleOption } from '../entities/scale-option.entity';
import { AssessmentCase } from '../entities/assessment-case.entity';
import { AssessorAnswer } from '../entities/assessor-answer.entity';
import { ReviewDecision } from '../entities/review-decision.entity';
import { NotificationRecord } from '../entities/notification.entity';
import { GradeEffectivePeriod } from '../entities/grade-period.entity';
import { FeeRateVersion } from '../entities/fee-rate-version.entity';
import { LeaveEventBatch } from '../entities/leave-event-batch.entity';
import { LeaveEvent } from '../entities/leave-event.entity';
import { LeaveSuspensionPeriod } from '../entities/leave-suspension-period.entity';
import { FeeSettlement } from '../entities/fee-settlement.entity';
import { FeeSettlementLine } from '../entities/fee-settlement-line.entity';
import { FeeAdjustment } from '../entities/fee-adjustment.entity';
import { FeeAdjustmentLine } from '../entities/fee-adjustment-line.entity';
import { migrateLeaveLedger } from './migrations/1700000000000-LeaveLedger';
import { seedDemoData } from './seed';

export const entities = [
  ScaleVersion,
  ScaleItem,
  ScaleOption,
  AssessmentCase,
  AssessorAnswer,
  ReviewDecision,
  NotificationRecord,
  GradeEffectivePeriod,
  FeeRateVersion,
  LeaveEventBatch,
  LeaveEvent,
  LeaveSuspensionPeriod,
  FeeSettlement,
  FeeSettlementLine,
  FeeAdjustment,
  FeeAdjustmentLine,
];

export function buildDataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'eldercare',
    entities,
    synchronize: false,
  };
}

/**
 * 幂等建表 + 防重叠排除约束（首次启动建表；后续启动只补缺）。
 * 同一老人同一天不得出现重叠生效等级：
 *   btree_gist 提供 daterange 排他约束（半开区间，相邻期间首尾相接不算重叠）。
 */
export async function ensureSchema(dataSource: DataSource): Promise<void> {
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  const exists = await dataSource.query(
    `SELECT to_regclass('grade_periods') IS NOT NULL AS ok`,
  );
  if (!exists[0].ok) {
    await dataSource.synchronize();
  }
  await migrateLeaveLedger(dataSource);

  const constraint = await dataSource.query(
    `SELECT 1 FROM pg_constraint WHERE conname = 'grade_periods_no_overlap'`,
  );
  if (constraint.length === 0) {
    await dataSource.query(`
      ALTER TABLE grade_periods
        ADD CONSTRAINT grade_periods_no_overlap
        EXCLUDE USING gist (
          elder_id WITH =,
          daterange(start_date, end_date_exclusive, '[)') WITH &&
        )
    `);
  }
}

let singleton: Promise<DataSource> | null = null;

/** 一次性“连接-建表-种子”（独立脚本使用） */
export async function buildInitializedDataSource(): Promise<DataSource> {
  const ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  await ensureSchema(ds);
  await seedDemoData(ds);
  return ds;
}

/** Nest 启动与 e2e 测试共用同一套“连接-建表-种子”流程 */
export function getOrCreateDataSource(): Promise<DataSource> {
  if (!singleton) {
    singleton = (async () => {
      const ds = new DataSource(buildDataSourceOptions());
      await ds.initialize();
      await ensureSchema(ds);
      await seedDemoData(ds);
      return ds;
    })();
    singleton.catch(() => {
      singleton = null; // 允许后续重试
    });
  }
  return singleton;
}
