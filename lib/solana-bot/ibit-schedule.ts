/**
 * ET-based windows for IBIT → Coinbase transfer monitoring and scaled cover.
 */

export const IBIT_TZ = 'America/New_York';

/** Monitor transfers 02:00–09:30 ET (inclusive start, exclusive end at 09:30). */
export function isWithinSignalWindowEt(now: Date = new Date()): boolean {
  const parts = getEtParts(now);
  const minutes = parts.hour * 60 + parts.minute;
  const start = 2 * 60; // 02:00
  const end = 9 * 60 + 30; // 09:30
  return minutes >= start && minutes < end;
}

/** Minutes since local midnight in IBIT_TZ (for block-time filters). */
export function getEtMinutesFromMidnight(d: Date): number {
  const p = getEtParts(d);
  return p.hour * 60 + p.minute;
}

/**
 * Whether block confirmation time falls in [startMin, endExclusiveMin) ET.
 * Example: 06:00–07:45 → startMin=360, endExclusiveMin=465.
 */
export function isBlockTimeInEtMinuteWindow(
  blockTimeSec: number,
  startMin: number,
  endExclusiveMin: number
): boolean {
  const m = getEtMinutesFromMidnight(new Date(blockTimeSec * 1000));
  return m >= startMin && m < endExclusiveMin;
}

/** 25 cover slots: 11:00, 11:10, …, 14:00 ET on the calendar day of `anchorUtc`. */
export function getCoverScheduleUtc(anchorUtc: Date): Date[] {
  const y = etYearMonthDay(anchorUtc);
  const slots: Date[] = [];
  for (let m = 0; m <= 180; m += 10) {
    slots.push(etLocalToUtc(y.year, y.month, y.day, 11, 0 + m));
  }
  return slots;
}

function getEtParts(d: Date): { hour: number; minute: number; second: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: IBIT_TZ,
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const second = Number(parts.find((p) => p.type === 'second')?.value ?? 0);
  return { hour, minute, second };
}

function etYearMonthDay(d: Date): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: IBIT_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const parts = fmt.formatToParts(d);
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? 1);
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  return { year, month, day };
}

/** Interpret ET calendar date + clock time as UTC instant (handles DST). */
function etLocalToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  const targetMin = hour * 60 + minute;
  let t = Date.UTC(year, month - 1, day, 12, 0, 0);
  for (let i = 0; i < 12; i++) {
    const d = new Date(t);
    const ymd = etYearMonthDay(d);
    const p = getEtParts(d);
    if (ymd.year !== year || ymd.month !== month || ymd.day !== day) {
      t += (day - ymd.day) * 24 * 60 * 60 * 1000;
      continue;
    }
    const actualMin = p.hour * 60 + p.minute;
    const diff = targetMin - actualMin;
    if (diff === 0) return d;
    t += diff * 60 * 1000;
  }
  return new Date(t);
}
