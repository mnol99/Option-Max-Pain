/**
 * Birdeye historical OHLCV - for backtest only.
 * Requires BIRDEYE_API_KEY in .env.local
 */

import type { OHLCVCandle } from './types';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

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
  const type = interval === '5m' ? '5m' : interval === '1h' ? '1H' : '1D';
  const url = `${BIRDEYE_BASE}/defi/ohlcv?address=${SOL_MINT}&type=${type}&time_from=${timeFrom}&time_to=${timeTo}&currency=usd`;
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
