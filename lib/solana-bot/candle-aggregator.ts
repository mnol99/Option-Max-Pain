/**
 * Build OHLCV candles from Doves oracle (Jupiter Perps) for multiple bar sizes.
 * Polls once per tick and updates 60m + Daily (ET) aggregations in parallel.
 */

import { fetchDovesPrice } from './doves-oracle';
import type { OHLCVCandle } from './types';
import {
  STRATEGY_INTERVALS,
  type StrategyIntervalSec,
  getCandleBoundary,
  DAILY_BAR_SEC,
} from './candle-intervals';
import { getNextEtDaily8pmBarStartUnix } from './ibit-schedule';

interface CurrentCandle {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const MAX_COMPLETED = 10;

const completedByInterval = new Map<StrategyIntervalSec, OHLCVCandle[]>();
const currentByInterval = new Map<StrategyIntervalSec, CurrentCandle | null>();

function ensureMaps(): void {
  for (const sec of STRATEGY_INTERVALS) {
    if (!completedByInterval.has(sec)) completedByInterval.set(sec, []);
    if (!currentByInterval.has(sec)) currentByInterval.set(sec, null);
  }
}

/** @deprecated use getCandleBoundary from candle-intervals */
export function get5mBoundary(ts: number): number {
  return getCandleBoundary(ts, 300);
}

function rollCandle(
  intervalSec: StrategyIntervalSec,
  completed: OHLCVCandle[],
  prev: CurrentCandle | null
): OHLCVCandle[] {
  if (!prev) return completed;
  const next = [
    {
      open: prev.open,
      high: prev.high,
      low: prev.low,
      close: prev.close,
      volume: 0,
      unixTime: prev.unixTime,
    },
    ...completed,
  ].slice(0, MAX_COMPLETED);
  return next;
}

/**
 * One Doves price sample and OHLC update for all intervals.
 * Call this on every API request / server tick so candles advance even when the
 * browser tab is suspended (no reliance on a background setInterval).
 */
export async function advanceCandlesOnce(): Promise<void> {
  try {
    const { price } = await fetchDovesPrice();
    const now = Math.floor(Date.now() / 1000);
    ensureMaps();

    for (const intervalSec of STRATEGY_INTERVALS) {
      let completed = completedByInterval.get(intervalSec)!;
      let current = currentByInterval.get(intervalSec);
      const boundary = getCandleBoundary(now, intervalSec);

      if (!current || current.unixTime !== boundary) {
        if (current) {
          completed = rollCandle(intervalSec, completed, current);
          completedByInterval.set(intervalSec, completed);
        }
        currentByInterval.set(intervalSec, {
          unixTime: boundary,
          open: price,
          high: price,
          low: price,
          close: price,
        });
      } else {
        current.high = Math.max(current.high, price);
        current.low = Math.min(current.low, price);
        current.close = price;
      }
    }
  } catch {
    // Silently retry on next call
  }
}

/**
 * Completed candles for a bar size (newest first). Caller should await
 * {@link advanceCandlesOnce} first so data is fresh.
 */
export function getCandles(intervalSec: StrategyIntervalSec): OHLCVCandle[] {
  ensureMaps();
  return [...(completedByInterval.get(intervalSec) ?? [])];
}

export function getCurrentCandleBoundary(intervalSec: number): number {
  return getCandleBoundary(Math.floor(Date.now() / 1000), intervalSec);
}

/**
 * Minutes until 4 completed candles exist for pattern detection
 */
export function getWarmupMinutes(intervalSec: StrategyIntervalSec): number {
  ensureMaps();
  const completed = completedByInterval.get(intervalSec) ?? [];
  const count = completed.length;
  if (count >= 4) return 0;
  const remaining = 4 - count;
  const now = Math.floor(Date.now() / 1000);
  const boundary = getCandleBoundary(now, intervalSec);
  const secsIntoPeriod = now - boundary;
  const secsUntilNext =
    intervalSec === 86400
      ? getNextEtDaily8pmBarStartUnix(now) - now
      : intervalSec - secsIntoPeriod;
  const barSec = intervalSec === 86400 ? DAILY_BAR_SEC : intervalSec;
  return Math.ceil((secsUntilNext + (remaining - 1) * barSec) / 60);
}
