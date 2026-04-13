/**
 * Binance spot SOL/USDT 1h klines — aligns bot 60m SOL candles with major CEX prints (MEXC/Binance/Bybit are typically very close).
 * Public API, no key. Only **closed** hours are merged (in-progress bar skipped for replacement).
 */

export interface Binance1hBar {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function isSol60mBinanceOhlcMergeEnabled(): boolean {
  return process.env.SOL_60M_MERGE_BINANCE_OHLC === '1';
}

/** Min interval between merge network calls (advanceCandlesOnce may run every few seconds). */
export function getSol60mBinanceMergeMinMs(): number {
  const n = Number(process.env.SOL_60M_BINANCE_MERGE_INTERVAL_MS);
  if (Number.isFinite(n) && n >= 15_000) return Math.floor(n);
  return 60_000;
}

export async function fetchBinanceSolUsdClosed1hKlines(limit = 48): Promise<Binance1hBar[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1h&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
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
