import { getEtDayStartUnix } from '@/lib/solana-bot/ibit-schedule';

/** Supported OHLC bar lengths (seconds) for multi-strategy tabs */
export const STRATEGY_INTERVALS = [3600, 86400] as const;
export type StrategyIntervalSec = (typeof STRATEGY_INTERVALS)[number];

export function intervalLabel(sec: number): string {
  if (sec === 3600) return '60m';
  if (sec === 86400) return 'Daily (ET)';
  return `${sec}s`;
}

export function parseIntervalParam(v: string | null): StrategyIntervalSec {
  const n = parseInt(v ?? '3600', 10);
  if (n === 3600 || n === 86400) return n;
  return 3600;
}

/**
 * Bar start unix (seconds). Hourly = UTC hour; Daily = ET calendar day 00:00 (DST-aware).
 */
export function getCandleBoundary(ts: number, intervalSec: number): number {
  if (intervalSec === 86400) {
    return getEtDayStartUnix(new Date(ts * 1000));
  }
  return Math.floor(ts / intervalSec) * intervalSec;
}
