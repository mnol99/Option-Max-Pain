/**
 * Build 5-minute OHLCV candles from Doves oracle (Jupiter Perps) price feed.
 * Polls the oracle and aggregates into candles. No historical API - candles
 * are built from live data. First pattern available ~20 min after bot starts.
 */

import { fetchDovesPrice } from './doves-oracle';
import type { OHLCVCandle } from './types';

function get5mBoundary(ts: number): number {
  return Math.floor(ts / 300) * 300;
}

interface CurrentCandle {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

let completedCandles: OHLCVCandle[] = [];
let currentCandle: CurrentCandle | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 5000; // Poll Doves every 5s for accurate OHLC (avoids false inside bars from undersampling)

async function tick(): Promise<void> {
  try {
    const { price } = await fetchDovesPrice();
    const now = Math.floor(Date.now() / 1000);
    const boundary = get5mBoundary(now);

    if (!currentCandle || currentCandle.unixTime !== boundary) {
      // Roll to new period: save completed candle, start new one
      if (currentCandle) {
        completedCandles.unshift({
          open: currentCandle.open,
          high: currentCandle.high,
          low: currentCandle.low,
          close: currentCandle.close,
          volume: 0, // Doves has no volume
          unixTime: currentCandle.unixTime,
        });
        // Keep last 10 candles
        if (completedCandles.length > 10) completedCandles = completedCandles.slice(0, 10);
      }
      currentCandle = {
        unixTime: boundary,
        open: price,
        high: price,
        low: price,
        close: price,
      };
    } else {
      currentCandle.high = Math.max(currentCandle.high, price);
      currentCandle.low = Math.min(currentCandle.low, price);
      currentCandle.close = price;
    }
  } catch {
    // Silently retry on next tick
  }
}

function startPolling(): void {
  if (pollInterval) return;
  tick();
  pollInterval = setInterval(tick, POLL_MS);
}

/**
 * Get completed 5m candles (newest first). Starts polling on first call.
 * Returns empty until at least one 5m period has completed (~5 min after start).
 */
export function getCandles(): OHLCVCandle[] {
  startPolling();
  return [...completedCandles];
}

/**
 * Get current forming candle if available (for display). unixTime + 300 <= now means complete.
 */
export function getCurrentCandleBoundary(): number {
  startPolling();
  return get5mBoundary(Math.floor(Date.now() / 1000));
}

/**
 * Estimate minutes until we have enough candles for pattern (4 needed)
 */
export function getWarmupMinutes(): number {
  const count = completedCandles.length;
  if (count >= 4) return 0;
  // Each full 5m period adds one candle
  const remaining = 4 - count;
  const now = Math.floor(Date.now() / 1000);
  const boundary = get5mBoundary(now);
  const secsIntoPeriod = now - boundary;
  const secsUntilNextCandle = 300 - secsIntoPeriod;
  return Math.ceil((secsUntilNextCandle + (remaining - 1) * 300) / 60);
}

export { get5mBoundary };
