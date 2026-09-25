import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LeaveEventType } from '../../entities/leave-event.entity';
import { LeavePeriodStatus } from '../../entities/leave-suspension-period.entity';

export class RecordLeaveEventDto {
  @IsString()
  @MaxLength(128)
  eventNo: string;

  @IsEnum(LeaveEventType)
  eventType: LeaveEventType;

  /** 实际离院/返院发生时间，必须带时区偏移或 Z，便于迟到/乱序补录。 */
  @IsISO8601({ strict: true })
  occurredAt: string;

  /** 同一老人所有事件中的稳定接收顺序；相同发生时间按它打破平局。 */
  @IsInt()
  @Min(1)
  receiveSequence: number;
}

export class RecordLeaveEventsDto {
  @IsString()
  @MaxLength(64)
  elderId: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  batchNo?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RecordLeaveEventDto)
  events: RecordLeaveEventDto[];
}

export class LeaveEventsQueryDto {
  @IsString()
  @MaxLength(64)
  elderId: string;
}

export class LeavePeriodsQueryDto extends LeaveEventsQueryDto {
  @IsOptional()
  @IsEnum(LeavePeriodStatus)
  status?: LeavePeriodStatus;
}

export class LeaveFeeTrialQueryDto extends LeaveEventsQueryDto {
  @IsISO8601({ strict: true })
  from: string;

  @IsISO8601({ strict: true })
  to: string;
}

export class SettlementQueryDto extends LeaveEventsQueryDto {}

export class AdjustmentsQueryDto extends LeaveEventsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(7)
  month?: string;
}

export class SettleFeesDto {
  @IsString()
  @MaxLength(64)
  elderId: string;

  /** YYYY-MM */
  @IsString()
  @MaxLength(7)
  month: string;
}
