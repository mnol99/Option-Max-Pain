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

/** BLK paper: 18 slots 10:00–12:50 ET (every 10m), same calendar day as anchor. */
export const BLK_COVER_SLOT_COUNT = 18;

export function getBlkCoverScheduleUtc(anchorUtc: Date): Date[] {
  const y = etYearMonthDay(anchorUtc);
  const slots: Date[] = [];
  for (let i = 0; i < BLK_COVER_SLOT_COUNT; i++) {
    slots.push(etLocalToUtc(y.year, y.month, y.day, 10, i * 10));
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

/** Start of ET calendar day (00:00) as UTC instant — handles DST. */
export function etLocalToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
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

/** Unix seconds at 00:00:00 America/New_York for the ET calendar day containing `instant`. */
export function getEtDayStartUnix(instant: Date): number {
  const y = etYearMonthDay(instant);
  return Math.floor(etLocalToUtc(y.year, y.month, y.day, 0, 0).getTime() / 1000);
}

/**
 * Daily bar for SOL strategy: **8:00 PM ET open** → **7:59:59 PM ET close** next calendar day
 * (23h 59m 59s). Next bar opens at the following **8:00 PM ET**. DST handled via etLocalToUtc.
 */
export const DAILY_BAR_SEC = 86399;

/**
 * Start unix of the daily bar containing `fromSec`: 8:00 PM ET such that
 * start ≤ fromSec ≤ start + DAILY_BAR_SEC (close 7:59:59 PM ET next calendar day).
 */
export function getEtDaily8pmBarStartUnix(fromSec: number): number {
  const ymdNow = etYearMonthDay(new Date(fromSec * 1000));
  const eightToday = Math.floor(
    etLocalToUtc(ymdNow.year, ymdNow.month, ymdNow.day, 20, 0).getTime() / 1000
  );
  if (fromSec >= eightToday && fromSec <= eightToday + DAILY_BAR_SEC) {
    return eightToday;
  }
  const dayStart = getEtDayStartUnix(new Date(fromSec * 1000));
  const prevInstant = new Date((dayStart - 1) * 1000);
  const ymdPrev = etYearMonthDay(prevInstant);
  const eightPrev = Math.floor(
    etLocalToUtc(ymdPrev.year, ymdPrev.month, ymdPrev.day, 20, 0).getTime() / 1000
  );
  if (fromSec >= eightPrev && fromSec <= eightPrev + DAILY_BAR_SEC) {
    return eightPrev;
  }
  return eightToday;
}

/** Start of the next ET midnight after `fromSec` (next calendar day boundary). */
export function getNextEtDayStartUnix(fromSec: number): number {
  const startToday = getEtDayStartUnix(new Date(fromSec * 1000));
  for (let h = 1; h <= 48; h++) {
    const t = fromSec + h * 3600;
    const boundary = getEtDayStartUnix(new Date(t * 1000));
    if (boundary > startToday) return boundary;
  }
  return startToday + 86400;
}

/** Next 8:00 PM ET strictly after `fromSec` (start of next daily bar). */
export function getNextEtDaily8pmBarStartUnix(fromSec: number): number {
  for (let ahead = 0; ahead < 10; ahead++) {
    const d = new Date((fromSec + ahead * 86400) * 1000);
    const y = etYearMonthDay(d);
    const eightPm = Math.floor(etLocalToUtc(y.year, y.month, y.day, 20, 0).getTime() / 1000);
    if (eightPm > fromSec) return eightPm;
  }
  return getEtDaily8pmBarStartUnix(fromSec) + DAILY_BAR_SEC + 1;
}

/** ET weekday: 0=Sun … 6=Sat (America/New_York). */
export function getEtWeekday(instant: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: IBIT_TZ,
    weekday: 'short',
  });
  const w = fmt.format(instant);
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return map[w] ?? 0;
}

/**
 * 60m strategy weekend halt (ET): closed Fri ≥5:00pm through Sun &lt;3:00pm; open Sun ≥3:00pm through Fri &lt;5:00pm.
 * Daily strategy ignores this — use only for tf60m.
 */
export function isWeekendHalt60mEt(now: Date = new Date()): boolean {
  const wd = getEtWeekday(now);
  const min = getEtMinutesFromMidnight(now);
  if (wd === 6) return true;
  if (wd === 5 && min >= 17 * 60) return true;
  if (wd === 0 && min < 15 * 60) return true;
  return false;
}
