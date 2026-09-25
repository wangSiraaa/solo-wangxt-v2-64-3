import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FeeSettlement } from './fee-settlement.entity';

/**
 * 已结算的逐日账。originalAmount 是当天等级/费率正常费用；
 * billedAmount 是结算时离院暂停后的应收，二者之后均不得被覆盖。
 */
@Entity('fee_settlement_lines')
@Index(['settlementId', 'feeDate'], { unique: true })
@Index(['elderId', 'feeDate'])
export class FeeSettlementLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'settlement_id', type: 'uuid' })
  settlementId: string;

  @ManyToOne(() => FeeSettlement, (s) => s.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'settlement_id' })
  settlement?: FeeSettlement;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'fee_date', type: 'date' })
  feeDate: string;

  @Column({ name: 'grade', type: 'varchar', length: 20, nullable: true })
  grade: string | null;

  @Column({ name: 'daily_rate', type: 'numeric', precision: 12, scale: 2, nullable: true })
  dailyRate: string | null;

  @Column({ name: 'original_amount', type: 'numeric', precision: 12, scale: 2 })
  originalAmount: string;

  @Column({ name: 'billed_amount', type: 'numeric', precision: 12, scale: 2 })
  billedAmount: string;

  @Column({ name: 'paused', type: 'boolean' })
  paused: boolean;

  @Column({ name: 'leave_period_key', type: 'varchar', length: 160, nullable: true })
  leavePeriodKey: string | null;

  @Column({ name: 'grade_period_id', type: 'uuid', nullable: true })
  gradePeriodId: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
