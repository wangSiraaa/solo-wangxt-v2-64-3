import {
  Column,
  Entity,
  Index,
  ManyToOne,
  JoinColumn,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { LeaveEventBatch } from './leave-event-batch.entity';

export enum LeaveEventType {
  LEAVE = 'LEAVE',
  RETURN = 'RETURN',
}

/**
 * 离/返院事件是只追加账本：任何回调都先稳定落库，再由事件历史物化暂停区间。
 * eventNo 为外部稳定事件号，重复回调幂等；receiveOrder 仅用于同一发生时刻的确定性排序。
 */
@Entity('leave_events')
@Index(['elderId', 'eventOccurredAt', 'receiveOrder'])
@Index(['elderId', 'receiveOrder'], { unique: true })
@Index(['eventNo'], { unique: true })
export class LeaveEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'event_no', type: 'varchar', length: 128 })
  eventNo: string;

  @Column({ name: 'event_type', type: 'varchar', length: 16 })
  eventType: LeaveEventType;

  @Column({ name: 'event_occurred_at', type: 'timestamptz' })
  eventOccurredAt: Date;

  /** 业务发生日（Asia/Shanghai）。由入库代码从带时区发生时间计算，避免 UTC 跨日。 */
  @Column({ name: 'event_date', type: 'date' })
  eventDate: string;

  @Column({ name: 'receive_order', type: 'integer' })
  receiveOrder: number;

  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;

  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  batchId: string | null;

  @ManyToOne(() => LeaveEventBatch, { nullable: true })
  @JoinColumn({ name: 'batch_id' })
  batch?: LeaveEventBatch;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
