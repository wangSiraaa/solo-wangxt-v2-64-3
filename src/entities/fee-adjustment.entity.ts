import {
  Column,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { FeeAdjustmentLine } from './fee-adjustment-line.entity';

export enum FeeAdjustmentType {
  /** 暂停导致原账多收，需退给住户 */
  REFUND = 'REFUND',
  /** 暂停被撤销/缩短导致原账少收，需补收 */
  SUPPLEMENT = 'SUPPLEMENT',
}

/** 迟到事件影响已结算月份时追加的调整单；绝不改写原结算头和原账明细。 */
@Entity('fee_adjustments')
@Index(['settlementId', 'batchId'], { unique: true })
export class FeeAdjustment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'settlement_id', type: 'uuid' })
  settlementId: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'period_month', type: 'varchar', length: 7 })
  periodMonth: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @Column({ name: 'adjustment_type', type: 'varchar', length: 20 })
  adjustmentType: FeeAdjustmentType;

  /** 带符号金额：退费为负，补收为正。 */
  @Column({ name: 'amount', type: 'numeric', precision: 12, scale: 2 })
  amount: string;

  @Column({ name: 'reason', type: 'text' })
  reason: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @OneToMany(() => FeeAdjustmentLine, (line) => line.adjustment)
  lines?: FeeAdjustmentLine[];
}
