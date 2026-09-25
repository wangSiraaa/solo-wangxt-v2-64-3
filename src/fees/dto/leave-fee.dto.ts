import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { LeaveEventType } from '../../common/leave.enums';

export class RecordLeaveEventDto {
  /** 外部回调稳定事件号；相同事件号重复投递必须携带相同事实 */
  @IsString()
  @MaxLength(128)
  eventId: string;

  @IsString()
  @MaxLength(64)
  elderId: string;

  @IsIn([LeaveEventType.DEPARTURE, LeaveEventType.RETURN])
  eventType: LeaveEventType;

  /** ISO-8601 带时区时间；业务日期按 Asia/Shanghai 日历日归并 */
  @IsISO8601({ strict: true })
  occurredAt: string;

  /** 接收顺序：单调递增整数，用于打破同刻事件和迟到事件顺序 */
  @IsInt()
  @Min(1)
  receivedSeq: number;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  note?: string;
}

export class RecordLeaveEventsBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecordLeaveEventDto)
  events: RecordLeaveEventDto[];
}

export class LeaveQueryDto {
  @IsString()
  @MaxLength(64)
  elderId: string;
}

export class LeaveTrialQueryDto {
  @IsString()
  @MaxLength(64)
  elderId: string;

  @IsISO8601({ strict: false })
  from: string;

  @IsISO8601({ strict: false })
  to: string;
}

export class SettleFeesDto {
  @IsString()
  @MaxLength(64)
  elderId: string;

  @IsISO8601({ strict: false })
  from: string;

  @IsISO8601({ strict: false })
  to: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}
