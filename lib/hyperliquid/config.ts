/**
 * Server-only env for Hyperliquid hourly band bot (0x EVM private key, never exposed as NEXT_PUBLIC_*).
 */

export function isHyperliquidHourlyEnabled(): boolean {
  return process.env.HL_HOURLY_BANDS_ENABLED === '1';
}

export function getHyperliquidTestnet(): boolean {
  return process.env.HL_TESTNET === '1';
}

function normalizeKey(raw: string | undefined): `0x${string}` | null {
  if (!raw?.trim()) return null;
  const s = raw.trim();
  if (s.startsWith('0x')) return s as `0x${string}`;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return `0x${s}` as `0x${string}`;
  return null;
}

export function getHyperliquidPrivateKey(): `0x${string}` | null {
  return normalizeKey(
    process.env.HL_API_PRIVATE_KEY ?? process.env.HYPERLIQUID_API_PRIVATE_KEY
  );
}

export function getHyperliquidUserAddress(): `0x${string}` | null {
  const a = process.env.HL_USER_ADDRESS?.trim() ?? process.env.HYPERLIQUID_API_WALLET_ADDRESS?.trim();
  if (!a) return null;
  if (a.startsWith('0x') && a.length === 42) return a as `0x${string}`;
  return null;
}

export function getHourlyCoin(): string {
  return (process.env.HL_COIN ?? 'SOL').trim().toUpperCase();
}

/** Margin in USD (collateral). Notional = this × leverage. */
export function getHourlyCollateralUsd(): number {
  const n = Number(process.env.HL_COLLATERAL_USD ?? 50);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

export function getHourlyLeverage(): number {
  const n = Number(process.env.HL_LEVERAGE ?? 2);
  if (!Number.isFinite(n) || n < 1) return 2;
  return Math.min(50, Math.max(1, n));
}

/** Cross margin (typical for simple automation). */
export function getHourlyCrossMargin(): boolean {
  return process.env.HL_ISOLATED !== '1';
}

/** How many whole minutes after the hour to wait (candle + clock alignment). */
export function getHourlyAfterMinute(): number {
  const n = Number(process.env.HL_HOURLY_AFTER_MINUTE ?? 1);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.min(30, n);
}

/** Heartbeat poll interval in ms. */
export function getHourlyLoopMs(): number {
  const n = Number(process.env.HL_HOURLY_LOOP_MS ?? 30_000);
  return Number.isFinite(n) && n >= 5000 ? n : 30_000;
}

/** When `1`, hourly tick cancels existing open limits on that coin before placing the new bracket. Default off — prior bands stay until fill or manual cancel (stacking exposure). */
export function getHourlyCancelPriorBands(): boolean {
  return process.env.HL_HOURLY_CANCEL_PRIOR_BANDS === '1';
}

// --- BLK (IBIT) live execution on Hyperliquid BTC perp ---

export function getBlkHyperliquidCoin(): string {
  return (process.env.BLK_HL_COIN ?? 'BTC').trim().toUpperCase();
}

/** Isolated perp for BLK; cross when unset/0. */
export function getBlkHyperliquidIsolated(): boolean {
  return process.env.BLK_HL_ISOLATED === '1';
}
