/**
 * Birdeye historical OHLCV - backtest and optional inside-bar warmup backfill.
 * Requires BIRDEYE_API_KEY in `.env.local` for those features.
 */

import type { OHLCVCandle } from './types';
import type { InsideBarUnderlying } from '@/lib/solana-bot/strategy-tabs';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Jupiter WBTC custody mint (Birdeye OHLCV address) */
const WBTC_MINT = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
/** Portal WETH (override with BIRDEYE_ETH_MINT if Birdeye returns no rows) */
const DEFAULT_WETH_MINT = '7vfCXTUXx5WJV5JADk17DUJ4kszgou87GMc9Bdw6BvB';

export function birdeyeMintForUnderlying(u: InsideBarUnderlying): string {
  if (u === 'sol') return SOL_MINT;
  if (u === 'btc') return WBTC_MINT;
  const env = process.env.BIRDEYE_ETH_MINT?.trim();
  return env || DEFAULT_WETH_MINT;
}

interface BirdeyeOHLCVItem {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  unixTime?: number;
  unix_time?: number;
}

interface BirdeyeOHLCVResponse {
  success: boolean;
  data?: { items: BirdeyeOHLCVItem[] };
}

export async function fetchHistoricalOHLCV(
  timeFrom: number,
  timeTo: number,
  apiKey: string,
  interval: '5m' | '1h' | '1d' = '5m'
): Promise<OHLCVCandle[]> {
  return fetchHistoricalOHLCVForMint(SOL_MINT, timeFrom, timeTo, apiKey, interval);
}

export async function fetchHistoricalOHLCVForMint(
  mintOrUnderlying: string | InsideBarUnderlying,
  timeFrom: number,
  timeTo: number,
  apiKey: string,
  interval: '5m' | '1h' | '1d' = '5m'
): Promise<OHLCVCandle[]> {
  const mint =
    mintOrUnderlying === 'sol' || mintOrUnderlying === 'btc' || mintOrUnderlying === 'eth'
      ? birdeyeMintForUnderlying(mintOrUnderlying)
      : mintOrUnderlying;
  const type = interval === '5m' ? '5m' : interval === '1h' ? '1H' : '1D';
  const url = `${BIRDEYE_BASE}/defi/ohlcv?address=${mint}&type=${type}&time_from=${timeFrom}&time_to=${timeTo}&currency=usd`;
  const res = await fetch(url, { headers: { 'X-API-KEY': apiKey } });
  if (!res.ok) {
    throw new Error(`Birdeye OHLCV failed: ${res.status}`);
  }
  const json: BirdeyeOHLCVResponse = await res.json();
  if (!json.success || !json.data?.items?.length) {
    return [];
  }
  const items = json.data.items;
  return items.map((item) => ({
    open: item.o,
    high: item.h,
    low: item.l,
    close: item.c,
    volume: item.v,
    unixTime: item.unixTime ?? item.unix_time ?? 0,
  }));
}
