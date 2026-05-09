/**
 * Indicators for mean-reversion strategy (15m closes).
 */

export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch > 0) gains += ch;
    else losses -= ch;
  }
  const avgG = gains / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    emaVal = values[i]! * k + emaVal * (1 - k);
  }
  return emaVal;
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function bollinger(
  closes: number[],
  period = 20,
  mult = 2
): { mid: number; upper: number; lower: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, x) => s + (x - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

/** VWAP from typical price * volume, reset at UTC day boundary per candle unixTime. */
export function vwapAtIndex(
  candles: Array<{ unixTime: number; open: number; high: number; low: number; close: number; volume: number }>,
  endIndexInclusive: number
): number | null {
  if (endIndexInclusive < 0 || endIndexInclusive >= candles.length) return null;
  const endTs = candles[endIndexInclusive]!.unixTime;
  const dayStart = utcDayStartSec(endTs);
  let pv = 0;
  let vv = 0;
  for (let i = endIndexInclusive; i >= 0; i--) {
    const c = candles[i]!;
    if (c.unixTime < dayStart) break;
    const tp = (c.high + c.low + c.close) / 3;
    const v = Math.max(c.volume, 1e-12);
    pv += tp * v;
    vv += v;
  }
  if (vv <= 0) return null;
  return pv / vv;
}

export function utcDayStartSec(unixTime: number): number {
  const d = new Date(unixTime * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

/** Bearish engulfing: curr open > prev close, curr close < prev open, bodies overlap. */
export function isBearishEngulfing(prev: OHLC, curr: OHLC): boolean {
  const pb = Math.abs(prev.close - prev.open);
  const cb = Math.abs(curr.close - curr.open);
  return (
    curr.close < curr.open &&
    prev.close > prev.open &&
    curr.open >= prev.close &&
    curr.close <= prev.open &&
    cb >= pb
  );
}

/** Bullish engulfing */
export function isBullishEngulfing(prev: OHLC, curr: OHLC): boolean {
  const pb = Math.abs(prev.close - prev.open);
  const cb = Math.abs(curr.close - curr.open);
  return (
    curr.close > curr.open &&
    prev.close < prev.open &&
    curr.open <= prev.close &&
    curr.close >= prev.open &&
    cb >= pb
  );
}

export interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}
