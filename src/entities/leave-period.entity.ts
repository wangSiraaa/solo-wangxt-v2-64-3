import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { LeavePeriodStatus } from '../common/leave.enums';

/**
 * 由 leave_events 归并出的离院期间。
 * 这是可重建的物化结果，不是原始事实；主键直接采用离院事件号，
 * 使重复归并保持稳定、可解释、可被调整单引用。
 */
@Entity('leave_periods')
@Index(['elderId', 'startDate'])
@Index(['elderId', 'endDateExclusive'])
export class LeavePeriod {
  @PrimaryColumn({ name: 'departure_event_id', type: 'varchar', length: 128 })
  departureEventId: string;

  @Column({ name: 'return_event_id', type: 'varchar', length: 128, nullable: true })
  returnEventId: string | null;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'status', type: 'varchar', length: 32 })
  status: LeavePeriodStatus;

  @Column({ name: 'start_date', type: 'date' })
  startDate: string;

  /** 暂停结束日（不含）；未配对返院时为空 */
  @Column({ name: 'end_date_exclusive', type: 'date', nullable: true })
  endDateExclusive: string | null;

  @Column({ name: 'departure_occurred_at', type: 'timestamptz' })
  departureOccurredAt: Date;

  @Column({ name: 'return_occurred_at', type: 'timestamptz', nullable: true })
  returnOccurredAt: Date | null;

  @Column({ name: 'departure_received_seq', type: 'bigint' })
  departureReceivedSeq: string;

  @Column({ name: 'return_received_seq', type: 'bigint', nullable: true })
  returnReceivedSeq: string | null;

  @Column({ name: 'status_reason', type: 'text' })
  statusReason: string;

  @Column({ name: 'materialized_batch_id', type: 'uuid' })
  materializedBatchId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
