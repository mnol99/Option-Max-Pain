/**
 * Dual-asset OHLCV from Jupiter Perps pricing: SOL via Doves oracle, BTC via Pyth
 * (both USD; aligns with perp marks). 15m + 1h bars, synthetic volume from poll ticks.
 */

import { fetchDovesPrice } from './doves-oracle';
import { fetchPythBtcPrice } from './pyth-price';
import type { OHLCVCandle } from './types';

export type MeanRevAsset = 'sol' | 'btc';

const MAX_15M = 120;
const MAX_1H = 168;
const POLL_MS = 15000;

interface Current {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVol: number;
}

const completed15 = new Map<MeanRevAsset, OHLCVCandle[]>();
const current15 = new Map<MeanRevAsset, Current | null>();
const completed1h = new Map<MeanRevAsset, OHLCVCandle[]>();
const current1h = new Map<MeanRevAsset, Current | null>();

function ensure(a: MeanRevAsset): void {
  if (!completed15.has(a)) completed15.set(a, []);
  if (!current15.has(a)) current15.set(a, null);
  if (!completed1h.has(a)) completed1h.set(a, []);
  if (!current1h.has(a)) current1h.set(a, null);
}

function boundary(ts: number, intervalSec: number): number {
  return Math.floor(ts / intervalSec) * intervalSec;
}

function rollInto(
  completed: OHLCVCandle[],
  prev: Current | null,
  max: number
): OHLCVCandle[] {
  if (!prev) return completed;
  const vol = Math.max(prev.tickVol, 1e-9);
  const row: OHLCVCandle = {
    open: prev.open,
    high: prev.high,
    low: prev.low,
    close: prev.close,
    volume: vol,
    unixTime: prev.unixTime,
  };
  return [row, ...completed].slice(0, max);
}

async function fetchPrice(asset: MeanRevAsset): Promise<number> {
  if (asset === 'sol') {
    const { price } = await fetchDovesPrice();
    return price;
  }
  const { price } = await fetchPythBtcPrice();
  return price;
}

function updateInterval(
  asset: MeanRevAsset,
  price: number,
  now: number,
  intervalSec: number,
  completed: Map<MeanRevAsset, OHLCVCandle[]>,
  current: Map<MeanRevAsset, Current | null>,
  maxLen: number
): void {
  ensure(asset);
  const b = boundary(now, intervalSec);
  let cur = current.get(asset);
  if (!cur || cur.unixTime !== b) {
    if (cur) {
      const arr = rollInto(completed.get(asset)!, cur, maxLen);
      completed.set(asset, arr);
    }
    current.set(asset, {
      unixTime: b,
      open: price,
      high: price,
      low: price,
      close: price,
      tickVol: 1e-6,
    });
  } else {
    cur.high = Math.max(cur.high, price);
    cur.low = Math.min(cur.low, price);
    cur.close = price;
    cur.tickVol += 1e-6;
    current.set(asset, cur);
  }
}

async function tickAsset(asset: MeanRevAsset, price: number, now: number): Promise<void> {
  updateInterval(asset, price, now, 900, completed15, current15, MAX_15M);
  updateInterval(asset, price, now, 3600, completed1h, current1h, MAX_1H);
}

async function tick(): Promise<void> {
  try {
    const [solP, btcP] = await Promise.all([fetchPrice('sol'), fetchPrice('btc')]);
    const now = Math.floor(Date.now() / 1000);
    await tickAsset('sol', solP, now);
    await tickAsset('btc', btcP, now);
  } catch {
    /* retry next tick */
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;

function start(): void {
  if (intervalId) return;
  void tick();
  intervalId = setInterval(tick, POLL_MS);
}

/** Newest first (same as pattern bot). */
export function getMeanRevCandles15m(asset: MeanRevAsset): OHLCVCandle[] {
  start();
  ensure(asset);
  return [...(completed15.get(asset) ?? [])];
}

export function getMeanRevCandles1h(asset: MeanRevAsset): OHLCVCandle[] {
  start();
  ensure(asset);
  return [...(completed1h.get(asset) ?? [])];
}

/** Oldest first for indicator arrays. */
export function candlesOldestFirst(candles: OHLCVCandle[]): OHLCVCandle[] {
  return [...candles].reverse();
}
