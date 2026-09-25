import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { LeaveAnomalyType } from '../common/leave.enums';

/** 无法形成可信暂停区间的离返院异常，供运营/财务解释和人工处理 */
@Entity('leave_anomalies')
@Index(['elderId', 'anomalyType'])
export class LeaveAnomaly {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'anomaly_type', type: 'varchar', length: 32 })
  anomalyType: LeaveAnomalyType;

  @Column({ name: 'departure_event_id', type: 'varchar', length: 128, nullable: true })
  departureEventId: string | null;

  @Column({ name: 'return_event_id', type: 'varchar', length: 128, nullable: true })
  returnEventId: string | null;

  @Column({ name: 'occurred_date', type: 'date', nullable: true })
  occurredDate: string | null;

  @Column({ name: 'reason', type: 'text' })
  reason: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
