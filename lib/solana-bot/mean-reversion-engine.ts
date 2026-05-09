/**
 * Mean reversion strategy evaluation on 15m candles (oldest first).
 */

import type { OHLCVCandle } from './types';
import {
  rsi,
  bollinger,
  vwapAtIndex,
  isBearishEngulfing,
  isBullishEngulfing,
} from './mean-reversion-indicators';

export type MeanRevDirection = 'long' | 'short';

export interface SpikeContext {
  spikeIndex: number;
  /** Fade direction */
  direction: MeanRevDirection;
  spikeOpen: number;
  spikeHigh: number;
  spikeLow: number;
  spikeClose: number;
  stopPrice: number;
  tp1Price: number;
  tp2Vwap: number;
}

const MOVE_PCT = 1.5;
const RSI_HIGH = 72;
const RSI_LOW = 28;
const VOL_MULT = 2;
const VWAP_EXT_PCT = 1.2;
const STOP_WICK_PCT = 0.5;

function bodyPct(c: OHLCVCandle): number {
  const o = c.open;
  if (o === 0) return 0;
  return (Math.abs(c.close - c.open) / o) * 100;
}

function sameDirection4Before(candles: OHLCVCandle[], spikeIdx: number): boolean {
  if (spikeIdx < 4) return false;
  const dirs: number[] = [];
  for (let i = spikeIdx - 4; i < spikeIdx; i++) {
    const c = candles[i]!;
    dirs.push(c.close >= c.open ? 1 : -1);
  }
  const allUp = dirs.every((d) => d >= 0);
  const allDown = dirs.every((d) => d <= 0);
  return allUp || allDown;
}

/**
 * Find most recent valid spike + confirmation ending at `lastClosedIndex` (confirmation candle).
 * candles: oldest first, indices 0..n-1. lastClosedIndex = last fully closed 15m bar.
 */
export function evaluateMeanReversion(
  candles: OHLCVCandle[],
  lastClosedIndex: number,
  options?: { hourlyCandlesOldestFirst?: OHLCVCandle[] }
): { context: SpikeContext; reasons: string[] } | null {
  const reasons: string[] = [];
  if (lastClosedIndex < 25) {
    reasons.push('need>=26 closed candles');
    return null;
  }

  const h = options?.hourlyCandlesOldestFirst;
  if (h && h.length >= 4 && hourlyTrendBlocks(h, 4)) {
    reasons.push('hourly_trending_4');
    return null;
  }

  // confirmation is at lastClosedIndex; spike is at lastClosedIndex - 1
  const confIdx = lastClosedIndex;
  const spikeIdx = confIdx - 1;
  if (spikeIdx < 20) return null;

  const spike = candles[spikeIdx]!;
  const conf = candles[confIdx]!;

  // 6) not all 4 prior same direction
  if (sameDirection4Before(candles, spikeIdx)) {
    reasons.push('prior_4_same_dir');
    return null;
  }

  // 1) single candle move >= 1.5%
  if (bodyPct(spike) < MOVE_PCT) {
    reasons.push('spike_body<' + MOVE_PCT + '%');
    return null;
  }

  const closes = candles.map((c) => c.close);
  const rsiSpike = rsi(closes.slice(0, spikeIdx + 1), 14);
  if (rsiSpike == null) {
    reasons.push('rsi_null');
    return null;
  }

  const spikeUp = spike.close > spike.open;
  const spikeDown = spike.close < spike.open;
  if (!spikeUp && !spikeDown) {
    reasons.push('spike_doji');
    return null;
  }

  // Direction: fade — up spike -> short, down spike -> long
  const direction: MeanRevDirection = spikeUp ? 'short' : 'long';

  // 2) RSI
  if (direction === 'short' && rsiSpike <= RSI_HIGH) {
    reasons.push('rsi_short_not>' + RSI_HIGH);
    return null;
  }
  if (direction === 'long' && rsiSpike >= RSI_LOW) {
    reasons.push('rsi_long_not<' + RSI_LOW);
    return null;
  }

  // 3) volume spike >= 2x MA20 of prior volumes (exclude spike)
  const vols = candles.slice(spikeIdx - 20, spikeIdx).map((c) => c.volume);
  const volMa = vols.reduce((a, b) => a + b, 0) / vols.length;
  if (spike.volume < VOL_MULT * volMa) {
    reasons.push('volume<' + VOL_MULT + 'x_ma20');
    return null;
  }

  // 4) VWAP extended at spike close
  const vwapSpike = vwapAtIndex(candles as any, spikeIdx);
  if (vwapSpike == null) {
    reasons.push('vwap_null');
    return null;
  }
  const extPct = (Math.abs(spike.close - vwapSpike) / vwapSpike) * 100;
  if (extPct < VWAP_EXT_PCT) {
    reasons.push('not_extended_from_vwap');
    return null;
  }

  // 5) confirmation candle
  const bbSpike = bollinger(closes.slice(0, spikeIdx + 1), 20, 2);
  const bbConf = bollinger(closes.slice(0, confIdx + 1), 20, 2);
  if (bbSpike == null || bbConf == null) {
    reasons.push('bb_null');
    return null;
  }

  const insideBands = (c: number, bb: { upper: number; lower: number }) =>
    c <= bb.upper && c >= bb.lower;
  const outsideUp = spike.close > bbSpike.upper;
  const outsideDown = spike.close < bbSpike.lower;

  let confirmed = false;
  if (direction === 'short') {
    if (isBearishEngulfing(spike, conf)) confirmed = true;
    if (outsideUp && insideBands(conf.close, bbConf)) confirmed = true;
  } else {
    if (isBullishEngulfing(spike, conf)) confirmed = true;
    if (outsideDown && insideBands(conf.close, bbConf)) confirmed = true;
  }
  if (!confirmed) {
    reasons.push('no_confirmation');
    return null;
  }

  // Stop 0.5% beyond wick
  let stopPrice: number;
  if (direction === 'short') {
    stopPrice = spike.high * (1 + STOP_WICK_PCT / 100);
  } else {
    stopPrice = spike.low * (1 - STOP_WICK_PCT / 100);
  }

  // TP1: 50% retrace of spike range
  const range = spike.high - spike.low;
  let tp1Price: number;
  if (direction === 'short') {
    tp1Price = spike.high - 0.5 * range;
  } else {
    tp1Price = spike.low + 0.5 * range;
  }

  const tp2Vwap = vwapAtIndex(candles as any, confIdx) ?? vwapSpike;

  return {
    context: {
      spikeIndex: spikeIdx,
      direction,
      spikeOpen: spike.open,
      spikeHigh: spike.high,
      spikeLow: spike.low,
      spikeClose: spike.close,
      stopPrice,
      tp1Price,
      tp2Vwap,
    },
    reasons: ['ok'],
  };
}

/** 1h trend filter: avoid if last 4 hourly candles all same direction. candles1h oldest first. */
export function hourlyTrendBlocks(
  candles1h: OHLCVCandle[],
  minBars = 4
): boolean {
  if (candles1h.length < minBars) return false;
  const last = candles1h.slice(-minBars);
  const dirs = last.map((c) => (c.close >= c.open ? 1 : -1));
  return dirs.every((d) => d === 1) || dirs.every((d) => d === -1);
}
