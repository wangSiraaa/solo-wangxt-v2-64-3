/**
 * 将带时区的 ISO 时间转换为机构业务日历日（示例机构固定 Asia/Shanghai）。
 * 输入必须携带时区；不用 JS 默认时区，避免部署环境不同导致命中日期漂移。
 */
export function businessDateInShanghai(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`非法时间：${String(value)}`);
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value;

  return `${get('year')}-${get('month')}-${get('day')}`;
}
