import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { LeaveEventType } from '../common/leave.enums';

/**
 * 离返院事件账本。事件一经接收即不可变：
 *  - eventId 是回调方提供的稳定事件号，重复投递只回放；
 *  - occurredAt 是事件实际发生时间，receivedSeq 是本系统接收顺序；
 *  - 暂停区间始终由该表完整历史重新物化，便于重启和补录回放。
 */
@Entity('leave_events')
@Index(['elderId', 'occurredAt'])
@Index(['elderId', 'receivedSeq'], { unique: true })
@Index(['eventId'], { unique: true })
export class LeaveEvent {
  @PrimaryColumn({ name: 'event_id', type: 'varchar', length: 128 })
  eventId: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'event_type', type: 'varchar', length: 20 })
  eventType: LeaveEventType;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt: Date;

  /** 由录入方提供的单调接收顺序；同一老人不可重复，迟到事件允许 occurredAt 更早 */
  @Column({ name: 'received_seq', type: 'bigint' })
  receivedSeq: string;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId: string;

  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash: string;

  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload: unknown;

  @CreateDateColumn({ name: 'received_at' })
  receivedAt: Date;
}
