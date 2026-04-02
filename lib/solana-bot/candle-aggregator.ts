/**
 * Build OHLCV candles from Jupiter Perps (SOL/Doves) + Pyth (BTC, ETH) for multiple bar sizes.
 * Polls once per tick and updates 60m + Daily (ET) per underlying in parallel.
 */

import { fetchDovesPrice } from './doves-oracle';
import { fetchPythBtcPrice, fetchPythEthPrice } from './pyth-price';
import type { OHLCVCandle } from './types';
import {
  STRATEGY_INTERVALS,
  type StrategyIntervalSec,
  getCandleBoundary,
  DAILY_BAR_SEC,
} from './candle-intervals';
import { getNextEtDaily8pmBarStartUnix } from './ibit-schedule';
import type { InsideBarUnderlying } from './strategy-tabs';

export const INSIDE_BAR_UNDERLYINGS: InsideBarUnderlying[] = ['sol', 'btc', 'eth'];

interface CurrentCandle {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const MAX_COMPLETED = 10;

function key(u: InsideBarUnderlying, intervalSec: StrategyIntervalSec): string {
  return `${u}:${intervalSec}`;
}

const completedByKey = new Map<string, OHLCVCandle[]>();
const currentByKey = new Map<string, CurrentCandle | null>();

function ensureMaps(): void {
  for (const u of INSIDE_BAR_UNDERLYINGS) {
    for (const sec of STRATEGY_INTERVALS) {
      const k = key(u, sec);
      if (!completedByKey.has(k)) completedByKey.set(k, []);
      if (!currentByKey.has(k)) currentByKey.set(k, null);
    }
  }
}

/** @deprecated use getCandleBoundary from candle-intervals */
export function get5mBoundary(ts: number): number {
  return getCandleBoundary(ts, 300);
}

function rollCandle(
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

async function fetchUnderlyingPrice(u: InsideBarUnderlying): Promise<number> {
  if (u === 'sol') {
    const { price } = await fetchDovesPrice();
    return price;
  }
  if (u === 'btc') {
    const { price } = await fetchPythBtcPrice();
    return price;
  }
  const { price } = await fetchPythEthPrice();
  return price;
}

/**
 * One price sample per underlying and OHLC update for all intervals.
 */
export async function advanceCandlesOnce(): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    ensureMaps();

    for (const u of INSIDE_BAR_UNDERLYINGS) {
      let price: number;
      try {
        price = await fetchUnderlyingPrice(u);
      } catch {
        continue;
      }

      for (const intervalSec of STRATEGY_INTERVALS) {
        const k = key(u, intervalSec);
        let completed = completedByKey.get(k)!;
        let current = currentByKey.get(k);
        const boundary = getCandleBoundary(now, intervalSec);

        if (!current || current.unixTime !== boundary) {
          if (current) {
            completed = rollCandle(completed, current);
            completedByKey.set(k, completed);
          }
          currentByKey.set(k, {
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
    }
  } catch {
    /* retry next tick */
  }
}

export function getCandles(
  underlying: InsideBarUnderlying,
  intervalSec: StrategyIntervalSec
): OHLCVCandle[] {
  ensureMaps();
  return [...(completedByKey.get(key(underlying, intervalSec)) ?? [])];
}

export function getCurrentCandleBoundary(intervalSec: number): number {
  return getCandleBoundary(Math.floor(Date.now() / 1000), intervalSec);
}

export function getWarmupMinutes(
  underlying: InsideBarUnderlying,
  intervalSec: StrategyIntervalSec
): number {
  ensureMaps();
  const completed = completedByKey.get(key(underlying, intervalSec)) ?? [];
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
