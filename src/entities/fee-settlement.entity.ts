import {
  Column,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FeeSettlementLine } from './fee-settlement-line.entity';

export enum FeeSettlementStatus {
  SETTLED = 'SETTLED',
}

/** 月度费用结算头。结算后原始费用只读，迟到离返院事件只能产生调整单。 */
@Entity('fee_settlements')
@Index(['elderId', 'periodMonth'], { unique: true })
export class FeeSettlement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  /** YYYY-MM */
  @Column({ name: 'period_month', type: 'varchar', length: 7 })
  periodMonth: string;

  @Column({ name: 'month_start', type: 'date' })
  monthStart: string;

  @Column({ name: 'month_end', type: 'date' })
  monthEnd: string;

  @Column({ name: 'status', type: 'varchar', length: 24 })
  status: FeeSettlementStatus;

  @Column({ name: 'original_amount', type: 'numeric', precision: 12, scale: 2 })
  originalAmount: string;

  @Column({ name: 'billed_amount', type: 'numeric', precision: 12, scale: 2 })
  billedAmount: string;

  @Column({ name: 'settled_at', type: 'timestamptz', default: () => 'now()' })
  settledAt: Date;

  @OneToMany(() => FeeSettlementLine, (line) => line.settlement)
  lines?: FeeSettlementLine[];
}
