/**
 * Birdeye API client for Solana price data
 * - 5-minute OHLCV for pattern detection
 * - Real-time price for breakout monitoring
 */

import type { OHLCVCandle } from './types';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
/** Wrapped SOL - main liquidity for SOL/USD */
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface BirdeyeOHLCVItem {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  unixTime?: number;
  unix_time?: number;
  address?: string;
  type?: string;
  currency?: string;
}

export interface BirdeyeOHLCVResponse {
  success: boolean;
  data?: {
    items: BirdeyeOHLCVItem[];
  };
}

export interface BirdeyePriceResponse {
  success: boolean;
  data?: {
    value: number;
    updateUnixTime?: number;
  };
}

function getApiKey(): string {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) {
    throw new Error('BIRDEYE_API_KEY not set in environment');
  }
  return key;
}

/**
 * Fetch 5-minute OHLCV candles for SOL
 * Returns most recent candles first (newest at index 0)
 */
export async function fetchOHLCV(
  timeFrom: number,
  timeTo: number,
  apiKey?: string
): Promise<OHLCVCandle[]> {
  const key = apiKey || getApiKey();
  const url = `${BIRDEYE_BASE}/defi/ohlcv?address=${SOL_MINT}&type=5m&time_from=${timeFrom}&time_to=${timeTo}&currency=usd`;
  const res = await fetch(url, {
    headers: { 'X-API-KEY': key },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Birdeye OHLCV failed: ${res.status} ${err}`);
  }
  const json: BirdeyeOHLCVResponse = await res.json();
  if (!json.success || !json.data?.items?.length) {
    return [];
  }
  return json.data.items.map((item) => ({
    open: item.o,
    high: item.h,
    low: item.l,
    close: item.c,
    volume: item.v,
    unixTime: item.unixTime ?? item.unix_time ?? 0,
  }));
}

/**
 * Fetch current SOL price (USD)
 */
export async function fetchPrice(apiKey?: string): Promise<number> {
  const key = apiKey || getApiKey();
  const url = `${BIRDEYE_BASE}/defi/price?address=${SOL_MINT}`;
  const res = await fetch(url, {
    headers: { 'X-API-KEY': key },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Birdeye price failed: ${res.status} ${err}`);
  }
  const json: BirdeyePriceResponse = await res.json();
  if (!json.success || json.data?.value == null) {
    throw new Error('Birdeye price: no data');
  }
  return json.data.value;
}

/**
 * Get aligned 5m boundaries (floor to :00, :05, :10, etc.)
 */
export function get5mBoundary(ts: number): number {
  return Math.floor(ts / 300) * 300;
}
