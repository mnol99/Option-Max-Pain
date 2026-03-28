/**
 * IBIT watch list: Bitcoin addresses (mainnet) and Coinbase deposit addresses.
 * Comma-separated env vars; trim and skip empties.
 *
 * Defaults from labeled BlackRock IBIT → Coinbase Prime transfers:
 * - fe091e4a9373d904be8224121bff7721dce94c77668870c7bc2675734cace57a
 * - 5402b3b2458499276cfc57ea517cc9f1e36a789717e52aceed5106b1a259801b
 * - 8a54616ca3cb7bbaaf98e12559d85cb9b666410417fa4ccd13622efcbca9a284
 */

/** BlackRock / custodian source addresses (tx inputs). */
export const DEFAULT_IBIT_BTC_WATCH_ADDRESSES = [
  'bc1qghm5t8lwz2nn4lgm38c990m93ynl578vkakcxr',
  'bc1qyvmfk8zh27a8jl3uqdm6y2jfffq099phm0gcpd',
  'bc1qwlnuda94e3y0kumav55rn9lah7nakh37xvpqsq',
] as const;

/** Coinbase Prime destinations (large deposit + repeated small output seen on both txs). */
export const DEFAULT_IBIT_BTC_COINBASE_ADDRESSES = [
  '36YZXcTVLPdyapYuqXdJEt46oMVB2NrzVv',
  '3J7cUjBZxvGRCwFBz3q23zAsnhFfZrDSSU',
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
