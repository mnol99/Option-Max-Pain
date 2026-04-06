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
/** Portal / Wormhole WETH (Birdeye may list a different canonical mint — see `birdeyeEthMintCandidates`) */
const DEFAULT_WETH_MINT = '7vfCXTUXx5WJV5JADk17DUJ4kszgou87GMc9Bdw6BvB';

/** Alternate WETH mints to try when OHLCV returns empty (comma-separated `BIRDEYE_ETH_MINTS` prepended). */
const DEFAULT_ETH_MINT_FALLBACKS = [
  DEFAULT_WETH_MINT,
  '4yrHms7ekgTBgJg77zJ33TsWrraqHsCXDtuSZqUsuGHb', // common WETH on Solana DEX listings
];

export function birdeyeEthMintCandidates(): string[] {
  const fromEnv = process.env.BIRDEYE_ETH_MINTS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const single = process.env.BIRDEYE_ETH_MINT?.trim();
  const list = [...(fromEnv ?? []), ...(single ? [single] : []), ...DEFAULT_ETH_MINT_FALLBACKS];
  return Array.from(new Set(list));
}

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
  return fetchHistoricalOHLCVForAddress(mint, timeFrom, timeTo, apiKey, interval);
}

/** Raw mint address (not `eth` / `sol` alias). */
export async function fetchHistoricalOHLCVForAddress(
  mintAddress: string,
  timeFrom: number,
  timeTo: number,
  apiKey: string,
  interval: '5m' | '1h' | '1d' = '5m'
): Promise<OHLCVCandle[]> {
  const type = interval === '5m' ? '5m' : interval === '1h' ? '1H' : '1D';
  const url = `${BIRDEYE_BASE}/defi/ohlcv?address=${mintAddress}&type=${type}&time_from=${timeFrom}&time_to=${timeTo}&currency=usd`;
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
