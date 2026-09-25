import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FeeAdjustment } from './fee-adjustment.entity';

/** 调整单的逐日来源：连接原费用行、离返院事件批次与新的暂停键。 */
@Entity('fee_adjustment_lines')
@Index(['adjustmentId', 'feeDate'], { unique: true })
@Index(['elderId', 'feeDate'])
export class FeeAdjustmentLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'adjustment_id', type: 'uuid' })
  adjustmentId: string;

  @ManyToOne(() => FeeAdjustment, (a) => a.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'adjustment_id' })
  adjustment?: FeeAdjustment;

  @Column({ name: 'settlement_line_id', type: 'uuid' })
  settlementLineId: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'fee_date', type: 'date' })
  feeDate: string;

  @Column({ name: 'before_billed_amount', type: 'numeric', precision: 12, scale: 2 })
  beforeBilledAmount: string;

  @Column({ name: 'desired_billed_amount', type: 'numeric', precision: 12, scale: 2 })
  desiredBilledAmount: string;

  /** 带符号差额，等于 desired - (原 billed + 既有调整)。 */
  @Column({ name: 'delta_amount', type: 'numeric', precision: 12, scale: 2 })
  deltaAmount: string;

  @Column({ name: 'leave_period_key', type: 'varchar', length: 160, nullable: true })
  leavePeriodKey: string | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
