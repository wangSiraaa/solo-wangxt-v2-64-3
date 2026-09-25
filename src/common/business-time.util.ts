/**
 * 机构示例统一按北京时间记录业务日；事件时间本身保留带时区 instant。
 */
export function shanghaiDate(occurredAt: string): string {
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) throw new Error(`非法时间：${occurredAt}`);
  return new Date(t + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const last = m === 2 && leap ? 29 : dim[m - 1];
  return `${month}-${String(last).padStart(2, '0')}`;
}

export function isValidMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}
