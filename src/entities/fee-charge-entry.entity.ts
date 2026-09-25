import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FeeLineStatus } from '../common/leave.enums';

/**
 * 结算时逐日落账的原始费用来源。
 * 离院补录只能新增调整单，不 UPDATE/DELETE 这些记录。
 */
@Entity('fee_charge_entries')
@Index(['settlementId', 'entryDate'])
@Index(['elderId', 'entryDate'])
export class FeeChargeEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'settlement_id', type: 'uuid' })
  settlementId: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'entry_date', type: 'date' })
  entryDate: string;

  @Column({ name: 'status', type: 'varchar', length: 32 })
  status: FeeLineStatus;

  @Column({ name: 'grade', type: 'varchar', length: 20, nullable: true })
  grade: string | null;

  @Column({ name: 'daily_rate', type: 'numeric', precision: 12, scale: 2, nullable: true })
  dailyRate: string | null;

  @Column({ name: 'base_amount', type: 'numeric', precision: 12, scale: 2 })
  baseAmount: string;

  @Column({ name: 'paused_amount', type: 'numeric', precision: 12, scale: 2 })
  pausedAmount: string;

  @Column({ name: 'net_amount', type: 'numeric', precision: 12, scale: 2 })
  netAmount: string;

  @Column({ name: 'grade_period_id', type: 'uuid', nullable: true })
  gradePeriodId: string | null;

  @Column({ name: 'rate_version_id', type: 'uuid', nullable: true })
  rateVersionId: string | null;

  @Column({ name: 'leave_period_departure_event_id', type: 'varchar', length: 128, nullable: true })
  leavePeriodDepartureEventId: string | null;

  @Column({ name: 'source', type: 'jsonb' })
  source: unknown;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
