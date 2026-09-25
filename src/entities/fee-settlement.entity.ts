import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** 已结算月份/区间的不可变汇总；重叠结算由数据库排除约束兜底 */
@Entity('fee_settlements')
@Index(['elderId', 'fromDate', 'toDate'])
export class FeeSettlement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'from_date', type: 'date' })
  fromDate: string;

  @Column({ name: 'to_date', type: 'date' })
  toDate: string;

  @Column({ name: 'base_amount', type: 'numeric', precision: 12, scale: 2 })
  baseAmount: string;

  @Column({ name: 'paused_amount', type: 'numeric', precision: 12, scale: 2 })
  pausedAmount: string;

  @Column({ name: 'net_amount', type: 'numeric', precision: 12, scale: 2 })
  netAmount: string;

  @Column({ name: 'total_days', type: 'int' })
  totalDays: number;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 128, nullable: true })
  idempotencyKey: string | null;

  @Column({ name: 'ledger_snapshot', type: 'jsonb' })
  ledgerSnapshot: unknown;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
