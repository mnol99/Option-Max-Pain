/**
 * Optional Birdeye OHLCV backfill so 60m / Daily strategies don't wait for 4 live bar closes
 * after a cold start. Uses the same Birdeye key as backtest; live ticks still use Doves/Pyth.
 */

import {
  fetchHistoricalOHLCVForAddress,
  fetchHistoricalOHLCVForMint,
  birdeyeEthMintCandidates,
} from '@/lib/solana-bot/birdeye-historical';
import type { OHLCVCandle } from '@/lib/solana-bot/types';
import {
  STRATEGY_INTERVALS,
  type StrategyIntervalSec,
  getCandleBoundary,
  DAILY_BAR_SEC,
} from '@/lib/solana-bot/candle-intervals';
import { getEtDaily8pmBarStartUnix } from '@/lib/solana-bot/ibit-schedule';
import type { InsideBarUnderlying } from '@/lib/solana-bot/strategy-tabs';

const NEED = 4;

function birdeyeBackfillEnabled(): boolean {
  if (process.env.INSIDE_BAR_DISABLE_BIRDEYE_BACKFILL === '1') return false;
  return Boolean(process.env.BIRDEYE_API_KEY?.trim());
}

/** Only use fully closed 1h candles (Birdeye may return the in-progress hour). */
function closedHourlyBars(items: OHLCVCandle[], nowSec: number): OHLCVCandle[] {
  return items.filter((c) => c.unixTime > 0 && c.unixTime + 3600 <= nowSec);
}

/** Newest first (matches candle-aggregator completed order). */
function sortNewestFirst(items: OHLCVCandle[]): OHLCVCandle[] {
  return [...items].sort((a, b) => b.unixTime - a.unixTime);
}

async function fetchEthHourlyWithMintFallback(
  timeFrom: number,
  timeTo: number,
  apiKey: string
): Promise<OHLCVCandle[]> {
  for (const mint of birdeyeEthMintCandidates()) {
    const rows = await fetchHistoricalOHLCVForAddress(mint, timeFrom, timeTo, apiKey, '1h');
    if (rows.length > 0) return rows;
  }
  return [];
}

function mapBirdeye1dToEtDailyBars(
  items: OHLCVCandle[],
  nowSec: number
): OHLCVCandle[] {
  const closed = items.filter((c) => c.unixTime > 0);
  const dailies: OHLCVCandle[] = [];
  for (const c of closed) {
    const dayStart = getEtDaily8pmBarStartUnix(c.unixTime);
    if (dayStart + DAILY_BAR_SEC >= nowSec) continue;
    dailies.push({
      unixTime: dayStart,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    });
  }
  const groups = new Map<number, OHLCVCandle[]>();
  for (const c of dailies) {
    const list = groups.get(c.unixTime) ?? [];
    list.push(c);
    groups.set(c.unixTime, list);
  }
  const merged: OHLCVCandle[] = [];
  for (const [dayStart, g] of Array.from(groups.entries())) {
    const sorted = [...g].sort((a, b) => a.unixTime - b.unixTime);
    merged.push({
      unixTime: dayStart,
      open: sorted[0]!.open,
      high: Math.max(...sorted.map((x) => x.high)),
      low: Math.min(...sorted.map((x) => x.low)),
      close: sorted[sorted.length - 1]!.close,
      volume: sorted.reduce((s, x) => s + x.volume, 0),
    });
  }
  return sortNewestFirst(merged);
}

function aggregateHourlyToEtDaily(
  hours: OHLCVCandle[],
  nowSec: number
): OHLCVCandle[] {
  const closed = closedHourlyBars(hours, nowSec);
  if (!closed.length) return [];

  const byDailyStart = new Map<number, OHLCVCandle[]>();
  for (const h of closed) {
    const mid = h.unixTime + 1800;
    const dayStart = getEtDaily8pmBarStartUnix(mid);
    const list = byDailyStart.get(dayStart) ?? [];
    list.push(h);
    byDailyStart.set(dayStart, list);
  }

  const dailies: OHLCVCandle[] = [];
  for (const [dayStart, group] of Array.from(byDailyStart.entries())) {
    if (dayStart + DAILY_BAR_SEC >= nowSec) continue;
    const g = [...group].sort((a, b) => a.unixTime - b.unixTime);
    const first = g[0]!;
    const last = g[g.length - 1]!;
    dailies.push({
      unixTime: dayStart,
      open: first.open,
      high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)),
      close: last.close,
      volume: g.reduce((s, x) => s + x.volume, 0),
    });
  }
  return sortNewestFirst(dailies);
}

/**
 * Fetch enough historical bars for warmup (4 completed). Returns newest-first list or null.
 */
export async function fetchBirdeyeBackfillCompleted(
  underlying: InsideBarUnderlying,
  intervalSec: StrategyIntervalSec,
  nowSec: number
): Promise<OHLCVCandle[] | null> {
  if (!birdeyeBackfillEnabled()) return null;
  const apiKey = process.env.BIRDEYE_API_KEY!.trim();

  const timeTo = nowSec;
  const timeFrom =
    intervalSec === 86400 ? nowSec - 14 * 86400 : nowSec - NEED * 3600 * 2;

  let raw: OHLCVCandle[];
  try {
    if (underlying === 'eth') {
      raw = await fetchEthHourlyWithMintFallback(timeFrom, timeTo, apiKey);
    } else {
      raw = await fetchHistoricalOHLCVForMint(
        underlying,
        timeFrom,
        timeTo,
        apiKey,
        '1h'
      );
    }
  } catch {
    return null;
  }

  if (intervalSec === 3600) {
    const closed = sortNewestFirst(closedHourlyBars(raw, nowSec));
    if (closed.length < NEED) return null;
    return closed.slice(0, NEED);
  }

  if (intervalSec === 86400) {
    let dailies = aggregateHourlyToEtDaily(raw, nowSec);
    if (dailies.length < NEED) {
      try {
        const timeFrom1d = nowSec - 60 * 86400;
        let oneDay: OHLCVCandle[];
        if (underlying === 'eth') {
          oneDay = [];
          for (const mint of birdeyeEthMintCandidates()) {
            oneDay = await fetchHistoricalOHLCVForAddress(mint, timeFrom1d, timeTo, apiKey, '1d');
            if (oneDay.length > 0) break;
          }
        } else {
          oneDay = await fetchHistoricalOHLCVForMint(
            underlying,
            timeFrom1d,
            timeTo,
            apiKey,
            '1d'
          );
        }
        dailies = mapBirdeye1dToEtDailyBars(oneDay, nowSec);
      } catch {
        /* keep hourly-derived dailies */
      }
    }
    if (dailies.length < NEED) return null;
    return dailies.slice(0, NEED);
  }

  return null;
}

export function shouldRunBirdeyeBackfill(
  completedCount: number,
  intervalSec: number
): boolean {
  if (!birdeyeBackfillEnabled()) return false;
  if (intervalSec !== STRATEGY_INTERVALS[0] && intervalSec !== STRATEGY_INTERVALS[1])
    return false;
  return completedCount < NEED;
}

/** After backfill, align in-progress hourly candle with live boundary (avoid duplicate hour). */
export function trimCurrentIfOverlapsBackfill(
  current: {
    unixTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
  } | null,
  completed: OHLCVCandle[],
  intervalSec: number,
  nowSec: number
): typeof current {
  if (!current || completed.length === 0) return current;
  const boundary = getCandleBoundary(nowSec, intervalSec);
  const newestCompletedStart = completed[0]?.unixTime;
  if (newestCompletedStart == null) return current;
  if (intervalSec === 3600 && current.unixTime === newestCompletedStart) {
    return null;
  }
  if (intervalSec === 86400 && current.unixTime === newestCompletedStart) {
    return null;
  }
  if (current.unixTime !== boundary) return current;
  return current;
}
