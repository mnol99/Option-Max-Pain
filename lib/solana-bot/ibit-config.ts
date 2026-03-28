/**
 * IBIT watch list: Bitcoin addresses (mainnet) and Coinbase deposit addresses.
 * Comma-separated env vars; trim and skip empties.
 *
 * Defaults match the ~300 BTC BlackRock → Coinbase outflow (tx
 * fe091e4a9373d904be8224121bff7721dce94c77668870c7bc2675734cace57a): source
 * input address and large-output destination only.
 */

/** BlackRock-side source (all inputs in that tx). */
export const DEFAULT_IBIT_BTC_WATCH_ADDRESSES = [
  'bc1qghm5t8lwz2nn4lgm38c990m93ynl578vkakcxr',
] as const;

/** Coinbase deposit (large vout ~300 BTC). */
export const DEFAULT_IBIT_BTC_COINBASE_ADDRESSES = [
  '36YZXcTVLPdyapYuqXdJEt46oMVB2NrzVv',
] as const;

function parseList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Source wallets to watch (e.g. BlackRock / IBIT cold). */
export function getIbitWatchSourceAddresses(): string[] {
  const fromEnv = parseList(process.env.IBIT_BTC_WATCH_ADDRESSES);
  if (fromEnv.length > 0) return fromEnv;
  return [...DEFAULT_IBIT_BTC_WATCH_ADDRESSES];
}

/** Coinbase (or other) destinations — match any vout address in this set. */
export function getIbitCoinbaseDestinationAddresses(): string[] {
  const fromEnv = parseList(process.env.IBIT_BTC_COINBASE_ADDRESSES);
  if (fromEnv.length > 0) return fromEnv;
  return [...DEFAULT_IBIT_BTC_COINBASE_ADDRESSES];
}

export function getIbitMinSats(): number {
  const n = Number(process.env.IBIT_MIN_SATS);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 100_000;
}
