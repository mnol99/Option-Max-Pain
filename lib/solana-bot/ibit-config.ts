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
 * - 37f7a152ec76414220d1c732b196b6a0f73d5d1b49b9f61890c7707f7728a947
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
  'bc1qw3fppdjfgm0z2hzwhejctqv8gg94caw3re29hl',
] as const;

/** Coinbase Prime destinations (large deposit + repeated small output seen on both txs). */
export const DEFAULT_IBIT_BTC_COINBASE_ADDRESSES = [
  '36YZXcTVLPdyapYuqXdJEt46oMVB2NrzVv',
  '3J7cUjBZxvGRCwFBz3q23zAsnhFfZrDSSU',
] as const;

/** Main Prime deposit address — used for ~200–300 BTC leg filter. */
export const DEFAULT_IBIT_MAIN_DEPOSIT_ADDRESS = DEFAULT_IBIT_BTC_COINBASE_ADDRESSES[0];

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

/** Primary deposit address for large-BTC heuristic (defaults to first Coinbase addr). */
export function getIbitMainDepositAddress(): string {
  const e = process.env.IBIT_MAIN_DEPOSIT_ADDRESS?.trim();
  if (e) return e;
  return DEFAULT_IBIT_MAIN_DEPOSIT_ADDRESS;
}

/**
 * Strict detection: ~daily batch time + main output size (see env overrides).
 * Set IBIT_DISABLE_STRICT_FILTERS=1 to use legacy 02:00–09:30 ET block filter only.
 */
export function isIbitStrictFiltersEnabled(): boolean {
  return process.env.IBIT_DISABLE_STRICT_FILTERS !== '1';
}

/** ET minute-of-day for detection window start (default 06:00 → 360). */
export function getIbitDetectStartMinEt(): number {
  const n = Number(process.env.IBIT_DETECT_START_MIN_ET);
  if (Number.isFinite(n) && n >= 0 && n < 24 * 60) return Math.floor(n);
  return 6 * 60;
}

/** ET minute-of-day, exclusive end (default 07:45 → 465). */
export function getIbitDetectEndMinEt(): number {
  const n = Number(process.env.IBIT_DETECT_END_MIN_ET);
  if (Number.isFinite(n) && n > 0 && n <= 24 * 60) return Math.floor(n);
  return 7 * 60 + 45;
}

export function getIbitMainOutMinBtc(): number {
  const n = Number(process.env.IBIT_MAIN_OUT_MIN_BTC);
  if (Number.isFinite(n) && n > 0) return n;
  return 200;
}

/** Optional upper bound on main deposit (BTC). Default: no cap (600, 900, 2700+ all pass). */
export function getIbitMainOutMaxBtc(): number | null {
  const raw = process.env.IBIT_MAIN_OUT_MAX_BTC?.trim();
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

/**
 * Extra txids to always fetch (comma-separated), e.g. Arkham transfers not yet in watch-address history.
 * Example: `IBIT_EXTRA_TXIDS=d6c82b60949803cf773342deb961a63eabc6228b2432420c5cda84527c79d585`
 */
export function getIbitExtraTxids(): string[] {
  const raw = process.env.IBIT_EXTRA_TXIDS?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * When `1`, block-time filters do not require the tx to be on **today's** ET calendar day
 * (allows replaying historical txs from `IBIT_EXTRA_TXIDS` / address history for testing).
 */
export function isIbitAllowHistoricalBlockDay(): boolean {
  return process.env.IBIT_ALLOW_HISTORICAL_SIGNALS === '1';
}

/**
 * When `1`, also poll legacy IBIT source (`bc1…`) watch addresses for outgoing txs.
 * Default off: detection is **Coinbase deposit first** (large transfer in → signal), then sender is recorded for audit.
 */
export function isIbitPollSourceWatchAddresses(): boolean {
  return process.env.IBIT_POLL_SOURCE_WATCH === '1';
}

/** Recent txs to pull per Coinbase address (Blockstream). Default 50. */
export function getIbitCoinbaseAddressTxLimit(): number {
  const n = Number(process.env.IBIT_COINBASE_TX_LIMIT);
  if (Number.isFinite(n) && n >= 5 && n <= 100) return Math.floor(n);
  return 50;
}

/** Arkham Intel API key (`API-Key` header). Do not commit. */
export function getArkhamApiKey(): string | undefined {
  const k = process.env.ARKHAM_API_KEY?.trim();
  return k || undefined;
}

/**
 * `base` filter for GET /transfers (entity slug or address), e.g. Arkham’s IBIT / BlackRock entity.
 * Override if your dashboard uses a different entity id.
 */
export function getArkhamTransferBase(): string {
  const e = process.env.ARKHAM_TRANSFER_BASE?.trim();
  if (e) return e;
  return 'blackrock';
}

/** Recent window for Arkham `timeLast` (e.g. 24h, 7d). */
export function getArkhamTimeLast(): string {
  const e = process.env.ARKHAM_TIME_LAST?.trim();
  if (e) return e;
  return '7d';
}

/** Max Arkham rows per poll (each matching tx still fetches Blockstream for validation). */
export function getArkhamTransferLimit(): number {
  const n = Number(process.env.ARKHAM_TRANSFER_LIMIT);
  if (Number.isFinite(n) && n >= 5 && n <= 50) return Math.floor(n);
  return 25;
}

/** Set to `0` to skip Arkham even when `ARKHAM_API_KEY` is set. */
export function isArkhamIbitPollEnabled(): boolean {
  return process.env.ARKHAM_DISABLE_IBIT_POLL !== '1';
}

/** When `1`, BLK signals come only from Arkham batch counting (2nd ~300 BTC out → short, 2nd ~300 BTC in → long). */
export function isArkhamBatchModeEnabled(): boolean {
  return process.env.ARKHAM_BATCH_MODE === '1';
}

/** Target batch size (BTC) for Arkham batch mode (default 300). */
export function getArkhamBatchTargetBtc(): number {
  const n = Number(process.env.ARKHAM_BATCH_TARGET_BTC);
  if (Number.isFinite(n) && n > 0) return n;
  return 300;
}

/** Half-band around target (default 50 → 250–350 BTC). */
export function getArkhamBatchToleranceBtc(): number {
  const n = Number(process.env.ARKHAM_BATCH_TOLERANCE_BTC);
  if (Number.isFinite(n) && n >= 0) return n;
  return 50;
}

/**
 * Tight half-band for **striker** leg in pair mode (default 25 → 275–325 BTC for target 300).
 * Run-up legs must be **below** `target - strikerTol` so ~266 BTC is not a striker.
 */
export function getArkhamBatchStrikerToleranceBtc(): number {
  const n = Number(process.env.ARKHAM_BATCH_STRIKER_TOLERANCE_BTC);
  if (Number.isFinite(n) && n >= 0) return n;
  return 25;
}

/** Minimum BTC for **run-up** leg before striker (default 200). */
export function getArkhamBatchRunMinBtc(): number {
  const n = Number(process.env.ARKHAM_BATCH_RUN_MIN_BTC);
  if (Number.isFinite(n) && n > 0) return n;
  return 200;
}

/**
 * Coinbase spend / cluster addresses used as prevouts on CB→BR (and change outputs to exclude for BR leg size).
 * Default includes the common Prime hot seen on large batch txs.
 */
export function getArkhamBatchCoinbaseSpendAddresses(): string[] {
  const fromEnv = parseList(process.env.ARKHAM_CB_SPEND_ADDRESSES);
  if (fromEnv.length > 0) return fromEnv;
  return ['3MqUP6G1daVS5YTD8fz3QgwjZortWwxXFd'];
}

/** Arkham `counterparties` slug (default coinbase). */
export function getArkhamCounterpartySlug(): string {
  const e = process.env.ARKHAM_COUNTERPARTY?.trim();
  return e || 'coinbase';
}

/** ET minute-of-day (inclusive) for 2nd **in** long signal (default 9:30 → 570). */
export function getArkhamLongAfterMinEt(): number {
  const n = Number(process.env.ARKHAM_LONG_AFTER_MIN_ET);
  if (Number.isFinite(n) && n >= 0 && n < 24 * 60) return Math.floor(n);
  return 9 * 60 + 30;
}

/** Skip Blockstream Coinbase deposit / legacy watch polls when `1` (use with batch mode). */
export function isIbitCoinbasePollEnabled(): boolean {
  return process.env.IBIT_DISABLE_COINBASE_POLL !== '1';
}

/** When `1` (default): CB→BR long on **2nd** ~300 BTC striker in chronological order (no run-up required). Set `0` to disable. */
export function isArkhamSecondStrikerLongEnabled(): boolean {
  return process.env.ARKHAM_SECOND_STRIKER_LONG !== '0';
}

/**
 * Max age (seconds) of **block time** for a signal to count as "fresh".
 * Default **2h** avoids re-triggering the same morning transfer hours later on refresh (when
 * localStorage is empty or a different origin). For a laptop that sleeps until afternoon, set
 * **`IBIT_SIGNAL_MAX_AGE_SEC`** higher (e.g. 43200) in `.env.local`. Processed txids are also
 * deduped in **localStorage** and on the **server** (`.data/blk-processed-txids.json`). Set `0`
 * to disable the age check (not recommended). Ignored when `IBIT_ALLOW_HISTORICAL_SIGNALS=1`.
 */
export function getIbitSignalMaxAgeSec(): number {
  const n = Number(process.env.IBIT_SIGNAL_MAX_AGE_SEC);
  if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  return 7200;
}

/**
 * When `1`, skip the server `setInterval` that calls `pollIbitTransfers` (browser/API-only polling).
 */
export function isIbitServerPollHeartbeatEnabled(): boolean {
  return process.env.IBIT_DISABLE_SERVER_POLL !== '1';
}

/**
 * Cadence for server-side IBIT poll (default 60s). Min 10s to reduce Arkham/Blockstream load.
 * Override with `IBIT_SERVER_POLL_MS`.
 */
export function getIbitServerPollIntervalMs(): number {
  const n = Number(process.env.IBIT_SERVER_POLL_MS);
  if (Number.isFinite(n) && n >= 10_000) return Math.floor(n);
  return 60_000;
}
