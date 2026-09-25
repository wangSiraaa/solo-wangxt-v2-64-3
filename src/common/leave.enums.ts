/** 离返院事件类型：只允许两种原始事实，状态由事件历史归并得出 */
export enum LeaveEventType {
  DEPARTURE = 'DEPARTURE',
  RETURN = 'RETURN',
}

/** 从不可变事件历史物化出的可解释配对状态 */
export enum LeavePeriodStatus {
  /** 离院与返院已配对，[startDate,endDateExclusive) 为暂停区间 */
  MATCHED = 'MATCHED',
  /** 只有离院事件，暂不暂停费用；试算中作为待配对风险展示 */
  AWAITING_RETURN = 'AWAITING_RETURN',
  /** 返院时间早于离院时间，不产生暂停区间 */
  RETURN_BEFORE_DEPARTURE = 'RETURN_BEFORE_DEPARTURE',
  /** 同一老人存在重叠离院事实，需人工核对，不自动合并 */
  OVERLAPPING_DEPARTURE = 'OVERLAPPING_DEPARTURE',
  /** 无离院事件可配对的孤立返院事件 */
  ORPHAN_RETURN = 'ORPHAN_RETURN',
}

export enum LeaveAnomalyType {
  RETURN_BEFORE_DEPARTURE = 'RETURN_BEFORE_DEPARTURE',
  ORPHAN_RETURN = 'ORPHAN_RETURN',
  OVERLAPPING_DEPARTURE = 'OVERLAPPING_DEPARTURE',
}

export enum FeeLineStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  NO_EFFECTIVE_GRADE = 'NO_EFFECTIVE_GRADE',
  AWAITING_RETURN = 'AWAITING_RETURN',
}

export enum AdjustmentType {
  /** 应补收：调整金额为正数 */
  SURCHARGE = 'SURCHARGE',
  /** 应退费：调整金额为负数 */
  REFUND = 'REFUND',
}

export enum AdjustmentStatus {
  POSTED = 'POSTED',
}
