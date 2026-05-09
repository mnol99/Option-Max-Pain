/**
 * Binance spot 1h klines — aligns bot 60m candles with major CEX prints (SOL/ETH/BTC USDT).
 * Public API, no key. Only **closed** hours are merged (in-progress bar skipped for replacement).
 */

export interface Binance1hBar {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type BinanceSpotUsdtSymbol = 'SOLUSDT' | 'ETHUSDT' | 'BTCUSDT';

export function isSol60mBinanceOhlcMergeEnabled(): boolean {
  return process.env.SOL_60M_MERGE_BINANCE_OHLC === '1';
}

export function isEth60mBinanceOhlcMergeEnabled(): boolean {
  return process.env.ETH_60M_MERGE_BINANCE_OHLC === '1';
}

export function isBtc60mBinanceOhlcMergeEnabled(): boolean {
  return process.env.BTC_60M_MERGE_BINANCE_OHLC === '1';
}

/** Min interval between merge network calls (advanceCandlesOnce may run every few seconds). */
export function getBinance60mMergeMinMs(): number {
  const n = Number(process.env.BINANCE_60M_MERGE_INTERVAL_MS ?? process.env.SOL_60M_BINANCE_MERGE_INTERVAL_MS);
  if (Number.isFinite(n) && n >= 15_000) return Math.floor(n);
  return 60_000;
}

/** @deprecated use getBinance60mMergeMinMs */
export function getSol60mBinanceMergeMinMs(): number {
  return getBinance60mMergeMinMs();
}

export async function fetchBinanceUsdtClosed1hKlines(
  symbol: BinanceSpotUsdtSymbol,
  limit = 48
): Promise<Binance1hBar[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${symbol} ${res.status}`);
  const data = (await res.json()) as unknown[];
  if (!Array.isArray(data)) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  const out: Binance1hBar[] = [];
  for (const row of data) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const openMs = Number(row[0]);
    if (!Number.isFinite(openMs)) continue;
    const unixTime = Math.floor(openMs / 1000);
    if (unixTime + 3600 > nowSec) continue;
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    if (![open, high, low, close].every((x) => Number.isFinite(x))) continue;
    out.push({ unixTime, open, high, low, close });
  }
  return out;
}

export async function fetchBinanceSolUsdClosed1hKlines(limit = 48): Promise<Binance1hBar[]> {
  return fetchBinanceUsdtClosed1hKlines('SOLUSDT', limit);
}
