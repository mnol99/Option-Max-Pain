import {
  getEtDaily8pmBarStartUnix,
  getNextEtDaily8pmBarStartUnix,
  DAILY_BAR_SEC,
} from '@/lib/solana-bot/ibit-schedule';

/** Supported OHLC bar lengths (seconds) for multi-strategy tabs */
export const STRATEGY_INTERVALS = [3600, 86400] as const;
export type StrategyIntervalSec = (typeof STRATEGY_INTERVALS)[number];

export function intervalLabel(sec: number): string {
  if (sec === 3600) return '60m';
  if (sec === 86400) return 'Daily (8pm ET)';
  return `${sec}s`;
}

export function parseIntervalParam(v: string | null): StrategyIntervalSec {
  const n = parseInt(v ?? '3600', 10);
  if (n === 3600 || n === 86400) return n;
  return 3600;
}

/**
 * Bar start unix (seconds). Hourly = UTC hour; Daily = **8:00 PM ET** (closes 7:59:59 PM ET next day).
 */
export function getCandleBoundary(ts: number, intervalSec: number): number {
  if (intervalSec === 86400) {
    return getEtDaily8pmBarStartUnix(ts);
  }
  return Math.floor(ts / intervalSec) * intervalSec;
}

/**
 * Start unix of the bar **after** a completed bar that began at `prevStartUnix`.
 * Used to backfill skipped boundaries when the process was down for multiple hours/days.
 */
export function nextBarStartAfter(prevStartUnix: number, intervalSec: number): number {
  if (intervalSec === 86400) {
    return getNextEtDaily8pmBarStartUnix(prevStartUnix);
  }
  return prevStartUnix + intervalSec;
}

/** Bar length for pattern / management window: daily = 86399s (8pm→7:59:59pm ET). */
export function effectiveBarDurationSec(intervalSec: number): number {
  if (intervalSec === 86400 || intervalSec === DAILY_BAR_SEC) return DAILY_BAR_SEC;
  return intervalSec;
}

export { getNextEtDaily8pmBarStartUnix, DAILY_BAR_SEC };
