import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** 调整单逐日来源：可回放“哪条原始账目被哪个事件修正” */
@Entity('fee_adjustment_items')
@Index(['adjustmentId', 'entryDate'])
@Index(['chargeEntryId', 'departureEventId', 'returnEventId'], { unique: true })
export class FeeAdjustmentItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'adjustment_id', type: 'uuid' })
  adjustmentId: string;

  @Column({ name: 'charge_entry_id', type: 'uuid' })
  chargeEntryId: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'entry_date', type: 'date' })
  entryDate: string;

  @Column({ name: 'original_amount', type: 'numeric', precision: 12, scale: 2 })
  originalAmount: string;

  @Column({ name: 'corrected_amount', type: 'numeric', precision: 12, scale: 2 })
  correctedAmount: string;

  @Column({ name: 'delta_amount', type: 'numeric', precision: 12, scale: 2 })
  deltaAmount: string;

  @Column({ name: 'departure_event_id', type: 'varchar', length: 128 })
  departureEventId: string;

  @Column({ name: 'return_event_id', type: 'varchar', length: 128, nullable: true })
  returnEventId: string | null;

  @Column({ name: 'source_batch_id', type: 'uuid' })
  sourceBatchId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
