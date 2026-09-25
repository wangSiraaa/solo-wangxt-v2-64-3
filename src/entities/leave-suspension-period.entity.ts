import {
  Column,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

export enum LeavePeriodStatus {
  MATCHED = 'MATCHED',
  OPEN_MISSING_RETURN = 'OPEN_MISSING_RETURN',
  ORPHAN_RETURN = 'ORPHAN_RETURN',
  RETURN_BEFORE_DEPARTURE = 'RETURN_BEFORE_DEPARTURE',
  NESTED_DEPARTURE = 'NESTED_DEPARTURE',
}

/**
 * 由 leave_events 确定性重放得到的物化解释状态。
 * MATCHED / OPEN 使用日期半开区间 [startDate,endDateExclusive)；
 * 返院异常没有可靠起点，startDate 允许为空。
 */
@Entity('leave_suspension_periods')
@Index(['elderId', 'startDate'])
export class LeaveSuspensionPeriod {
  /** 有效区间以离院事件号为稳定主键；异常以事件本身 eventNo 派生。 */
  @PrimaryColumn({ name: 'period_key', type: 'varchar', length: 160 })
  periodKey: string;

  @Column({ name: 'elder_id', type: 'varchar', length: 64 })
  elderId: string;

  @Column({ name: 'status', type: 'varchar', length: 32 })
  status: LeavePeriodStatus;

  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate: string | null;

  /** 返院异常没有开始区间；该列保存返院业务日，仅用于查询和展示，不参与排他。 */
  @Column({ name: 'event_date', type: 'date', nullable: true })
  eventDate: string | null;

  @Column({ name: 'end_date_exclusive', type: 'date', nullable: true })
  endDateExclusive: string | null;

  @Column({ name: 'leave_event_id', type: 'uuid', nullable: true })
  leaveEventId: string | null;

  @Column({ name: 'return_event_id', type: 'uuid', nullable: true })
  returnEventId: string | null;

  @Column({ name: 'leave_event_no', type: 'varchar', length: 128, nullable: true })
  leaveEventNo: string | null;

  @Column({ name: 'return_event_no', type: 'varchar', length: 128, nullable: true })
  returnEventNo: string | null;

  @Column({ name: 'explanation', type: 'text' })
  explanation: string;

  @Column({ name: 'materialized_at', type: 'timestamptz', default: () => 'now()' })
  materializedAt: Date;
}
