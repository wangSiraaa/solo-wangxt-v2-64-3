import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AdjustmentStatus, AdjustmentType } from '../common/leave.enums';

/** 迟到离返院事件对已结算费用产生的追加调整单（补收/退费） */
@Entity('fee_adjustments')
@Index(['elderId', 'settlementId'])
@Index(['sourceBatchId', 'settlementId'], { unique: true })
export class FeeAdjustment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'settlement_id', type: 'uuid' })
  settlementId: string;

  @Column({ name: 'adjustment_type', type: 'varchar', length: 20 })
  adjustmentType: AdjustmentType;

  /** REFUND 为负数，SURCHARGE 为正数 */
  @Column({ name: 'amount', type: 'numeric', precision: 12, scale: 2 })
  amount: string;

  @Column({ name: 'status', type: 'varchar', length: 20, default: AdjustmentStatus.POSTED })
  status: AdjustmentStatus;

  @Column({ name: 'reason', type: 'text' })
  reason: string;

  @Column({ name: 'source_batch_id', type: 'uuid' })
  sourceBatchId: string;

  @Column({ name: 'source_event_ids', type: 'jsonb' })
  sourceEventIds: string[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
