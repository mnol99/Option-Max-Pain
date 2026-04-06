/**
 * Build OHLCV candles from Jupiter Perps (SOL/Doves) + Pyth (BTC, ETH) for multiple bar sizes.
 * Polls once per tick and updates 60m + Daily (ET) per underlying in parallel.
 *
 * In **development**, completed + in-progress candles are persisted to disk (see below) so
 * `next dev` restarts do not wipe warmup (4 completed bars) for 60m/Daily strategies.
 */

import fs from 'node:fs';
import path from 'node:path';

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
import {
  fetchBirdeyeBackfillCompleted,
  shouldRunBirdeyeBackfill,
  trimCurrentIfOverlapsBackfill,
} from '@/lib/solana-bot/candle-birdeye-backfill';

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

let candleDiskLoaded = false;

/** Successful Birdeye seed for (underlying × interval). Failed fetches retry every `BIRDEYE_BACKFILL_RETRY_MS`. */
const birdeyeBackfillSucceeded = new Set<string>();
const birdeyeBackfillLastAttempt = new Map<string, number>();
const BIRDEYE_BACKFILL_RETRY_MS = 60_000;

function isCandlePersistenceEnabled(): boolean {
  if (process.env.INSIDE_BAR_DISABLE_CANDLE_PERSIST === '1') return false;
  if (process.env.INSIDE_BAR_CANDLES_PERSIST_PATH?.trim()) return true;
  return process.env.NODE_ENV === 'development';
}

function getCandlePersistencePath(): string {
  const raw = process.env.INSIDE_BAR_CANDLES_PERSIST_PATH?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  return path.join(process.cwd(), '.data', 'inside-bar-candles.json');
}

interface CandlePersistPayload {
  v: 1;
  savedAt: number;
  completed: Record<string, OHLCVCandle[]>;
  current: Record<string, CurrentCandle | null>;
}

function loadCandlesFromDiskOnce(): void {
  if (candleDiskLoaded || !isCandlePersistenceEnabled()) return;
  candleDiskLoaded = true;
  const file = getCandlePersistencePath();
  try {
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    const p = JSON.parse(raw) as CandlePersistPayload;
    if (p.v !== 1 || !p.completed || !p.current) return;
    ensureMaps();
    for (const [k, arr] of Object.entries(p.completed)) {
      if (!Array.isArray(arr)) continue;
      if (completedByKey.has(k)) {
        completedByKey.set(
          k,
          arr
            .filter(
              (c) =>
                c &&
                typeof c.unixTime === 'number' &&
                typeof c.open === 'number' &&
                typeof c.close === 'number'
            )
            .slice(0, MAX_COMPLETED)
        );
      }
    }
    for (const [k, cur] of Object.entries(p.current)) {
      if (!currentByKey.has(k)) continue;
      if (cur == null) {
        currentByKey.set(k, null);
      } else if (
        typeof cur.unixTime === 'number' &&
        typeof cur.open === 'number' &&
        typeof cur.high === 'number' &&
        typeof cur.low === 'number' &&
        typeof cur.close === 'number'
      ) {
        currentByKey.set(k, { ...cur });
      }
    }
  } catch {
    /* corrupt or missing */
  }
}

function persistCandlesToDisk(): void {
  if (!isCandlePersistenceEnabled()) return;
  try {
    ensureMaps();
    const file = getCandlePersistencePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const completed: Record<string, OHLCVCandle[]> = {};
    const current: Record<string, CurrentCandle | null> = {};
    for (const [k, v] of Array.from(completedByKey.entries())) completed[k] = [...v];
    for (const [k, v] of Array.from(currentByKey.entries())) current[k] = v ? { ...v } : null;
    const payload: CandlePersistPayload = {
      v: 1,
      savedAt: Date.now(),
      completed,
      current,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* read-only fs, etc. */
  }
}

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

async function maybeBirdeyeBackfill(
  u: InsideBarUnderlying,
  intervalSec: StrategyIntervalSec,
  nowSec: number
): Promise<void> {
  const k = key(u, intervalSec);
  if (birdeyeBackfillSucceeded.has(k)) return;
  const completed = completedByKey.get(k) ?? [];
  if (!shouldRunBirdeyeBackfill(completed.length, intervalSec)) return;

  const nowMs = Date.now();
  const last = birdeyeBackfillLastAttempt.get(k) ?? 0;
  if (nowMs - last < BIRDEYE_BACKFILL_RETRY_MS && last > 0) return;
  birdeyeBackfillLastAttempt.set(k, nowMs);

  const backfilled = await fetchBirdeyeBackfillCompleted(u, intervalSec, nowSec);
  if (!backfilled?.length) return;

  birdeyeBackfillSucceeded.add(k);
  completedByKey.set(k, backfilled.slice(0, MAX_COMPLETED));
  const cur = currentByKey.get(k) ?? null;
  currentByKey.set(k, trimCurrentIfOverlapsBackfill(cur, backfilled, intervalSec, nowSec));
  persistCandlesToDisk();
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
    loadCandlesFromDiskOnce();

    for (const u of INSIDE_BAR_UNDERLYINGS) {
      for (const intervalSec of STRATEGY_INTERVALS) {
        await maybeBirdeyeBackfill(u, intervalSec, now);
      }
    }

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
    persistCandlesToDisk();
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
