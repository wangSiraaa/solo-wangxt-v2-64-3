import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum LeaveBatchStatus {
  ACCEPTED = 'ACCEPTED',
}

/**
 * 一次离返院事件补录请求的整批边界。
 * 并发/重复冲突时整事务回滚；已接收批次用同一 batchNo 回放。
 */
@Entity('leave_event_batches')
@Index(['batchNo'], { unique: true })
export class LeaveEventBatch {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'batch_no', type: 'varchar', length: 128 })
  batchNo: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'status', type: 'varchar', length: 24 })
  status: LeaveBatchStatus;

  @Column({ name: 'event_count', type: 'integer' })
  eventCount: number;

  @Column({ name: 'received_at', type: 'timestamptz', default: () => 'now()' })
  receivedAt: Date;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
