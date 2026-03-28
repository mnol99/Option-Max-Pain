/**
 * IBIT watch list: Bitcoin addresses (mainnet) and Coinbase deposit addresses.
 * Comma-separated env vars; trim and skip empties.
 *
 * Defaults from labeled BlackRock IBIT → Coinbase Prime transfers:
 * - fe091e4a9373d904be8224121bff7721dce94c77668870c7bc2675734cace57a
 * - 5402b3b2458499276cfc57ea517cc9f1e36a789717e52aceed5106b1a259801b
 * - 8a54616ca3cb7bbaaf98e12559d85cb9b666410417fa4ccd13622efcbca9a284
 * - 00024740452ba63c00963ba1ee30950ca0f6d641549e54f080c012eae752704b
 * - 0c3774e1c6034a399b00aaeb7ba2ad63dadab22ff9411a409edc13a13b395d1e
 * - a464eedf6ce19c4ae597a9f15e50dfb6f0c693dfd4403ee463a0f8a7473e59f4
 * - 35fd0dbbf43910e9a25600784b4121eb0ccfa01e1c2fcb1ca42681e39dc7d348
 * - 94e39faac11ac1c0ef36a8030d0d80a982c3568b8f5a7a93a1754166ce7ab5ff
 * - cb7cd27eed747ea94ec18d4b98734dc6cb5eb0b52a123788a8c01ac4393b4479
 * - 7f6a8b43236c31798386ca2bf15a6381b2a3ed5f444f56da15f4cda10089cd2d
 * - ab191d55047832f58cfb02b061b9fd6c72be854113ad0c9362160e03e7beaef1
 */

/** BlackRock / custodian source addresses (tx inputs). */
export const DEFAULT_IBIT_BTC_WATCH_ADDRESSES = [
  'bc1qghm5t8lwz2nn4lgm38c990m93ynl578vkakcxr',
  'bc1qyvmfk8zh27a8jl3uqdm6y2jfffq099phm0gcpd',
  'bc1qwlnuda94e3y0kumav55rn9lah7nakh37xvpqsq',
  'bc1qr72zukueftqg9gqa7ahsq0qkdm9waswqlv7j8f',
  'bc1qtl4c00zn2pfm9z0pqajql2fuzuh6p3f608z960',
  'bc1qmsj20amvjnk8087ntj47jdepq0mk23yqlclj34',
  'bc1q76ypn2c5jeyf4ugnsmd578yfmjh2r5h27j84dn',
  'bc1qu5rcfcp2f7wr9t389rdsy6qf77c4d2rk2za7g4',
  'bc1qwykacvxpwqy48h7y7kn2sv5zgdd4277gp9s8r2',
  'bc1qsn9slxylhevwgp94la9ccmhasdk9l539dwcxv0',
  'bc1qy0tgh7cshn2t56lqe0e0at507hc0muj05tzntx',
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
