/**
 * IBIT watch list: Bitcoin addresses (mainnet) and Coinbase deposit addresses.
 * Comma-separated env vars; trim and skip empties.
 */

function parseList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Source wallets to watch (e.g. BlackRock / IBIT cold). */
export function getIbitWatchSourceAddresses(): string[] {
  return parseList(process.env.IBIT_BTC_WATCH_ADDRESSES);
}

/** Coinbase (or other) destinations — match any vout address in this set. */
export function getIbitCoinbaseDestinationAddresses(): string[] {
  const fromEnv = parseList(process.env.IBIT_BTC_COINBASE_ADDRESSES);
  if (fromEnv.length > 0) return fromEnv;
  return [];
}

export function getIbitMinSats(): number {
  const n = Number(process.env.IBIT_MIN_SATS);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 100_000;
}
