import { DataSource } from 'typeorm';

/**
 * 离返院账本的幂等数据库迁移。
 * 新项目可由 TypeORM synchronize 首次建表；既有库则依赖本迁移补表和约束。
 * 所有新增账目只追加，不修改历史费用列。
 */
export async function migrateLeaveLedger(dataSource: DataSource): Promise<void> {
  await dataSource.query('CREATE EXTENSION IF NOT EXISTS btree_gist');

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS leave_events (
      event_id varchar(128) PRIMARY KEY,
      elder_id varchar(64) NOT NULL,
      event_type varchar(20) NOT NULL CHECK (event_type IN ('DEPARTURE','RETURN')),
      occurred_at timestamptz NOT NULL,
      received_seq bigint NOT NULL,
      batch_id uuid NOT NULL,
      payload_hash varchar(64) NOT NULL,
      raw_payload jsonb NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_leave_events_elder_time
      ON leave_events (elder_id, occurred_at);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_leave_events_elder_seq
      ON leave_events (elder_id, received_seq);
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS leave_periods (
      departure_event_id varchar(128) PRIMARY KEY,
      return_event_id varchar(128),
      elder_id varchar(64) NOT NULL,
      status varchar(32) NOT NULL CHECK (status IN (
        'MATCHED','AWAITING_RETURN','RETURN_BEFORE_DEPARTURE',
        'OVERLAPPING_DEPARTURE','ORPHAN_RETURN'
      )),
      start_date date NOT NULL,
      end_date_exclusive date,
      departure_occurred_at timestamptz NOT NULL,
      return_occurred_at timestamptz,
      departure_received_seq bigint NOT NULL,
      return_received_seq bigint,
      status_reason text NOT NULL,
      materialized_batch_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_leave_periods_elder_start
      ON leave_periods (elder_id, start_date);
    CREATE INDEX IF NOT EXISTS idx_leave_periods_elder_end
      ON leave_periods (elder_id, end_date_exclusive);
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS leave_anomalies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      elder_id varchar(64) NOT NULL,
      anomaly_type varchar(32) NOT NULL CHECK (anomaly_type IN (
        'RETURN_BEFORE_DEPARTURE','ORPHAN_RETURN','OVERLAPPING_DEPARTURE'
      )),
      departure_event_id varchar(128),
      return_event_id varchar(128),
      occurred_date date,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_leave_anomalies_elder_type
      ON leave_anomalies (elder_id, anomaly_type);
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS fee_settlements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      elder_id varchar(64) NOT NULL,
      from_date date NOT NULL,
      to_date date NOT NULL,
      base_amount numeric(12,2) NOT NULL,
      paused_amount numeric(12,2) NOT NULL,
      net_amount numeric(12,2) NOT NULL,
      total_days integer NOT NULL,
      idempotency_key varchar(128),
      ledger_snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (from_date <= to_date)
    );
    CREATE INDEX IF NOT EXISTS idx_fee_settlements_range
      ON fee_settlements (elder_id, from_date, to_date);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_settlements_idem
      ON fee_settlements (elder_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS fee_charge_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      settlement_id uuid NOT NULL REFERENCES fee_settlements(id),
      elder_id varchar(64) NOT NULL,
      entry_date date NOT NULL,
      status varchar(32) NOT NULL,
      grade varchar(20),
      daily_rate numeric(12,2),
      base_amount numeric(12,2) NOT NULL,
      paused_amount numeric(12,2) NOT NULL,
      net_amount numeric(12,2) NOT NULL,
      grade_period_id uuid,
      rate_version_id uuid,
      leave_period_departure_event_id varchar(128),
      source jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_fee_entries_settlement_date
      ON fee_charge_entries (settlement_id, entry_date);
    CREATE INDEX IF NOT EXISTS idx_fee_entries_elder_date
      ON fee_charge_entries (elder_id, entry_date);
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS fee_adjustments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      elder_id varchar(64) NOT NULL,
      settlement_id uuid NOT NULL REFERENCES fee_settlements(id),
      adjustment_type varchar(20) NOT NULL CHECK (adjustment_type IN ('SURCHARGE','REFUND')),
      amount numeric(12,2) NOT NULL CHECK (amount <> 0),
      status varchar(20) NOT NULL DEFAULT 'POSTED',
      reason text NOT NULL,
      source_batch_id uuid NOT NULL,
      source_event_ids jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_fee_adjustments_elder_settlement
      ON fee_adjustments (elder_id, settlement_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_adjustments_batch_settlement
      ON fee_adjustments (source_batch_id, settlement_id);
  `);

  await dataSource.query(`
    CREATE TABLE IF NOT EXISTS fee_adjustment_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      adjustment_id uuid NOT NULL REFERENCES fee_adjustments(id),
      charge_entry_id uuid NOT NULL REFERENCES fee_charge_entries(id),
      elder_id varchar(64) NOT NULL,
      entry_date date NOT NULL,
      original_amount numeric(12,2) NOT NULL,
      corrected_amount numeric(12,2) NOT NULL,
      delta_amount numeric(12,2) NOT NULL CHECK (delta_amount <> 0),
      departure_event_id varchar(128) NOT NULL,
      return_event_id varchar(128),
      source_batch_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_fee_adjustment_items_adjustment
      ON fee_adjustment_items (adjustment_id, entry_date);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_adjustment_items_source
      ON fee_adjustment_items (charge_entry_id, departure_event_id, COALESCE(return_event_id, ''));

    ALTER TABLE fee_adjustment_items
      ADD COLUMN IF NOT EXISTS source_batch_id uuid;
  `);

  await addConstraintIfMissing(
    dataSource,
    'leave_periods_no_overlap',
    `ALTER TABLE leave_periods
       ADD CONSTRAINT leave_periods_no_overlap
       EXCLUDE USING gist (
         elder_id WITH =,
         daterange(start_date, end_date_exclusive, '[)') WITH &&
       )
       WHERE (status = 'MATCHED')`,
  );

  await addConstraintIfMissing(
    dataSource,
    'fee_settlements_no_overlap',
    `ALTER TABLE fee_settlements
       ADD CONSTRAINT fee_settlements_no_overlap
       EXCLUDE USING gist (
         elder_id WITH =,
         daterange(from_date, to_date, '[]') WITH &&
       )`,
  );
}

async function addConstraintIfMissing(
  dataSource: DataSource,
  name: string,
  ddl: string,
): Promise<void> {
  const found = await dataSource.query(
    `SELECT 1 FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  if (found.length === 0) await dataSource.query(ddl);
}
