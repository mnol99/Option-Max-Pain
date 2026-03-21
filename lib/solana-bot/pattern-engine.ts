/**
 * Pattern detection: inside bar + smallest of past 3 ranges
 * 5-minute chart for SOL
 */

import type { OHLCVCandle, PatternSetup } from './types';

/**
 * Check if current bar is inside prior bar
 * low_prior < low_current AND high_current < high_prior
 */
function isInsideBar(current: OHLCVCandle, prior: OHLCVCandle): boolean {
  return prior.low < current.low && current.high < prior.high;
}

/**
 * Check if current bar has the smallest range among current + prior 3
 */
function isSmallestRange(
  current: OHLCVCandle,
  prior1: OHLCVCandle,
  prior2: OHLCVCandle,
  prior3: OHLCVCandle
): boolean {
  const rangeCurrent = current.high - current.low;
  const range1 = prior1.high - prior1.low;
  const range2 = prior2.high - prior2.low;
  const range3 = prior3.high - prior3.low;
  return rangeCurrent < range1 && rangeCurrent < range2 && rangeCurrent < range3;
}

/**
 * Detect pattern from last 4 candles (newest = index 0)
 * Candles expected: [current (just closed), prior1, prior2, prior3]
 */
export function detectPattern(candles: OHLCVCandle[]): PatternSetup | null {
  if (candles.length < 4) return null;
  const [current, prior1, prior2, prior3] = candles;
  if (!current || !prior1 || !prior2 || !prior3) return null;

  if (!isInsideBar(current, prior1)) return null;
  if (!isSmallestRange(current, prior1, prior2, prior3)) return null;

  const range = current.high - current.low;
  const tick = 0.01; // 1 cent tick for stop levels

  return {
    detectedAt: Math.floor(Date.now() / 1000),
    breakoutHigh: current.high,
    breakoutLow: current.low,
    range,
    tpLong: current.high + range,
    tpShort: current.low - range,
    stopShort: current.high + tick,
    stopLong: current.low - tick,
    periodEnd: current.unixTime + 300, // 5 min after candle start
  };
}

/**
 * Check if price has broken above high (long trigger)
 */
export function isBreakoutLong(price: number, setup: PatternSetup): boolean {
  return price > setup.breakoutHigh;
}

/**
 * Check if price has broken below low (short trigger)
 */
export function isBreakoutShort(price: number, setup: PatternSetup): boolean {
  return price < setup.breakoutLow;
}
