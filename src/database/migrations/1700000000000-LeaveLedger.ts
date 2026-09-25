import { DataSource } from 'typeorm';

/**
 * 离返院事件账本与已结算/调整账的幂等迁移。
 *
 * 设计原则：
 * - 事件表只追加，稳定事件号唯一，保证重复回调不重复入账；
 * - 暂停区间由事件历史可随时重建，有效区间加排他约束防止重叠；
 * - 已结算费用和调整单分离，迟到事件只能 INSERT 调整，不 UPDATE/DELETE 原账。
 */
export async function migrateLeaveLedger(dataSource: DataSource): Promise<void> {
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS leave_event_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_no varchar(128) NOT NULL,
      elder_id varchar(64) NOT NULL,
      status varchar(24) NOT NULL,
      event_count integer NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS leave_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      elder_id varchar(64) NOT NULL,
      event_no varchar(128) NOT NULL,
      event_type varchar(16) NOT NULL,
      event_occurred_at timestamptz NOT NULL,
      event_date date NOT NULL,
      receive_order integer NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      batch_id uuid NULL REFERENCES leave_event_batches(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT leave_events_type_check CHECK (event_type IN ('LEAVE','RETURN')),
      CONSTRAINT leave_events_receive_order_positive CHECK (receive_order > 0)
    );

    CREATE TABLE IF NOT EXISTS leave_suspension_periods (
      period_key varchar(160) PRIMARY KEY,
      elder_id varchar(64) NOT NULL,
      status varchar(32) NOT NULL,
      start_date date NULL,
      event_date date NULL,
      end_date_exclusive date NULL,
      leave_event_id uuid NULL REFERENCES leave_events(id),
      return_event_id uuid NULL REFERENCES leave_events(id),
      leave_event_no varchar(128) NULL,
      return_event_no varchar(128) NULL,
      explanation text NOT NULL,
      materialized_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT leave_periods_status_check CHECK (
        status IN (
          'MATCHED',
          'OPEN_MISSING_RETURN',
          'ORPHAN_RETURN',
          'RETURN_BEFORE_DEPARTURE',
          'NESTED_DEPARTURE'
        )
      )
    );

    CREATE TABLE IF NOT EXISTS fee_settlements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      elder_id varchar(64) NOT NULL,
      period_month varchar(7) NOT NULL,
      month_start date NOT NULL,
      month_end date NOT NULL,
      status varchar(24) NOT NULL,
      original_amount numeric(12,2) NOT NULL,
      billed_amount numeric(12,2) NOT NULL,
      settled_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fee_settlement_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      settlement_id uuid NOT NULL REFERENCES fee_settlements(id) ON DELETE CASCADE,
      elder_id varchar(64) NOT NULL,
      fee_date date NOT NULL,
      grade varchar(20) NULL,
      daily_rate numeric(12,2) NULL,
      original_amount numeric(12,2) NOT NULL,
      billed_amount numeric(12,2) NOT NULL,
      paused boolean NOT NULL,
      leave_period_key varchar(160) NULL,
      grade_period_id uuid NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fee_adjustments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      settlement_id uuid NOT NULL REFERENCES fee_settlements(id),
      elder_id varchar(64) NOT NULL,
      period_month varchar(7) NOT NULL,
      batch_id uuid NOT NULL REFERENCES leave_event_batches(id),
      adjustment_type varchar(20) NOT NULL,
      amount numeric(12,2) NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fee_adjustments_type_check
        CHECK (adjustment_type IN ('REFUND','SUPPLEMENT')),
      CONSTRAINT fee_adjustments_amount_not_zero CHECK (amount <> 0)
    );

    CREATE TABLE IF NOT EXISTS fee_adjustment_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      adjustment_id uuid NOT NULL REFERENCES fee_adjustments(id) ON DELETE CASCADE,
      settlement_line_id uuid NOT NULL REFERENCES fee_settlement_lines(id),
      batch_id uuid NOT NULL REFERENCES leave_event_batches(id),
      elder_id varchar(64) NOT NULL,
      fee_date date NOT NULL,
      before_billed_amount numeric(12,2) NOT NULL,
      desired_billed_amount numeric(12,2) NOT NULL,
      delta_amount numeric(12,2) NOT NULL,
      leave_period_key varchar(160) NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fee_adjustment_lines_delta_not_zero CHECK (delta_amount <> 0)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ux_leave_event_batches_no
      ON leave_event_batches(batch_no);
    CREATE INDEX IF NOT EXISTS ix_leave_event_batches_elder
      ON leave_event_batches(elder_id);

    CREATE UNIQUE INDEX IF NOT EXISTS ux_leave_events_no
      ON leave_events(event_no);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_leave_events_elder_receive
      ON leave_events(elder_id, receive_order);
    CREATE INDEX IF NOT EXISTS ix_leave_events_elder_time
      ON leave_events(elder_id, event_occurred_at, receive_order);
    CREATE INDEX IF NOT EXISTS ix_leave_events_elder_date_type
      ON leave_events(elder_id, event_date, event_type);

    CREATE INDEX IF NOT EXISTS ix_leave_periods_elder_start
      ON leave_suspension_periods(elder_id, start_date);
    CREATE INDEX IF NOT EXISTS ix_leave_periods_status
      ON leave_suspension_periods(status);

    CREATE UNIQUE INDEX IF NOT EXISTS ux_fee_settlements_elder_month
      ON fee_settlements(elder_id, period_month);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_fee_settlement_lines_settlement_date
      ON fee_settlement_lines(settlement_id, fee_date);
    CREATE INDEX IF NOT EXISTS ix_fee_settlement_lines_elder_date
      ON fee_settlement_lines(elder_id, fee_date);

    CREATE UNIQUE INDEX IF NOT EXISTS ux_fee_adjustments_settlement_batch
      ON fee_adjustments(settlement_id, batch_id);
    CREATE INDEX IF NOT EXISTS ix_fee_adjustments_elder_month
      ON fee_adjustments(elder_id, period_month);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_fee_adjustment_lines_adjustment_date
      ON fee_adjustment_lines(adjustment_id, fee_date);
    CREATE INDEX IF NOT EXISTS ix_fee_adjustment_lines_elder_date
      ON fee_adjustment_lines(elder_id, fee_date);

    ALTER TABLE leave_suspension_periods
      ADD COLUMN IF NOT EXISTS event_date date;
  `);

  await addConstraintIfMissing(
    dataSource,
    'leave_periods_no_overlap',
    `ALTER TABLE leave_suspension_periods
       ADD CONSTRAINT leave_periods_no_overlap
       EXCLUDE USING gist (
         elder_id WITH =,
         daterange(start_date, end_date_exclusive, '[)') WITH &&
       )
       WHERE (
         status IN ('MATCHED','OPEN_MISSING_RETURN')
         AND start_date IS NOT NULL
       )`,
  );
};

async function addConstraintIfMissing(
  dataSource: DataSource,
  name: string,
  ddl: string,
): Promise<void> {
  const rows = await dataSource.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  if (rows.length === 0) await dataSource.query(ddl);
}
