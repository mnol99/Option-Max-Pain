/**
 * "Prior hour high / low" band for SOL: each completed hour, take previous 1h candle from Binance;
 * when Doves mark from /price crosses into those bands, fire Jupiter *market* increases (emulates
 * sell-at-high and buy-at-low intent — not separate CLOB resting orders on Jupiter Perps).
 */

import path from 'node:path';
import fs from 'node:fs';
import { fetchBinanceSolUsdClosed1hKlines } from '@/lib/solana-bot/binance-spot-ohlc';
import { fetchDovesPrice } from '@/lib/solana-bot/doves-oracle';
import { fetchPythPrice } from '@/lib/solana-bot/pyth-price';
import { jupiterPerpExecuteMarket } from '@/lib/solana-bot/jupiter-perp-execute';
import { getServerTradingKeypair, isServerTradingSigningEnabled } from '@/lib/solana-bot/trading-wallet';

const DATA_DIR = process.env.OPTION_MAX_PAIN_DATA_DIR || '.data';
const STATE_FILE = 'hourly-band-sol.json';

export interface HourlyBandSolState {
  lastProcessedCandleOpenSec: number;
  longSigAtCandle: string | null;
  shortSigAtCandle: string | null;
  updatedAt: number;
}

function dataPath(): string {
  return path.join(process.cwd(), DATA_DIR, STATE_FILE);
}

export function getDefaultHourlyBandSolState(): HourlyBandSolState {
  return {
    lastProcessedCandleOpenSec: 0,
    longSigAtCandle: null,
    shortSigAtCandle: null,
    updatedAt: 0,
  };
}

export function loadHourlyBandSolState(): HourlyBandSolState {
  try {
    const p = dataPath();
    if (!fs.existsSync(p)) return getDefaultHourlyBandSolState();
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<HourlyBandSolState>;
    return {
      ...getDefaultHourlyBandSolState(),
      ...j,
    };
  } catch {
    return getDefaultHourlyBandSolState();
  }
}

function saveState(s: HourlyBandSolState): void {
  const p = dataPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
}

function isHourlyBandSolEnabled(): boolean {
  return process.env.HOURLY_BAND_SOL_ENABLED === '1';
}

function getConfig(): { sizeUsd: number; leverage: number; pollMs: number; eps: number } {
  const sizeUsd = Math.max(1, Number(process.env.HOURLY_BAND_SOL_SIZE_USD ?? 50) || 50);
  const leverage = Math.max(1, Math.min(100, Number(process.env.HOURLY_BAND_SOL_LEVERAGE ?? 1.5) || 1.5));
  const pollMs = Math.max(5000, Number(process.env.HOURLY_BAND_SOL_POLL_MS ?? 5000) || 5000);
  /** Relative band half-width: trigger when |mark - level|/level <= eps (0.0005 = 0.05%). */
  const eps = Math.max(0, Number(process.env.HOURLY_BAND_SOL_TRIGGER_EPS ?? 0.0005) || 0.0005);
  return { sizeUsd, leverage, pollMs, eps };
}

async function fetchMarkSolDovesOrPyth(): Promise<{ price: number; timestamp: number }> {
  const source = process.env.SOLANA_PRICE_SOURCE || 'doves';
  return source === 'pyth' ? fetchPythPrice() : fetchDovesPrice();
}

export type HourlyBandTickResult = {
  ran: boolean;
  log: string;
  longSignature?: string;
  shortSignature?: string;
  priorBar?: { unixTime: number; high: number; low: number };
  mark?: number;
};

export async function runHourlyBandSolTick(): Promise<HourlyBandTickResult> {
  if (!isHourlyBandSolEnabled()) {
    return { ran: false, log: 'disabled' };
  }
  if (!isServerTradingSigningEnabled()) {
    return { ran: false, log: 'SOLANA_TRADING_SERVER_SIGNING is not 1' };
  }
  try {
    getServerTradingKeypair();
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ran: false, log: `no server key: ${m}` };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const { sizeUsd, leverage, eps } = getConfig();

  const klines = await fetchBinanceSolUsdClosed1hKlines(4);
  /** Newest fully closed 1h bar (Binance returns klines newest-first; we filter incomplete). */
  const bar = klines[0] ?? null;
  if (!bar) {
    return { ran: true, log: 'no closed 1h klines' };
  }

  if (bar.high <= bar.low) {
    return { ran: true, log: 'invalid bar range' };
  }

  let mark: number;
  try {
    const p = await fetchMarkSolDovesOrPyth();
    mark = p.price;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return { ran: true, log: `mark: ${m}` };
  }
  if (mark <= 0) {
    return { ran: true, log: 'no mark price' };
  }

  let st = loadHourlyBandSolState();
  if (st.lastProcessedCandleOpenSec !== bar.unixTime) {
    st = {
      lastProcessedCandleOpenSec: bar.unixTime,
      longSigAtCandle: null,
      shortSigAtCandle: null,
      updatedAt: nowSec,
    };
    saveState(st);
  }

  const highDist = Math.abs(mark - bar.high) / bar.high;
  const lowDist = Math.abs(mark - bar.low) / bar.low;
  const atHigh = highDist <= eps;
  const atLow = lowDist <= eps;
  if (!atHigh && !atLow) {
    return {
      ran: true,
      log: `wait mark=${mark.toFixed(4)} barH=${bar.high} barL=${bar.low} eps=${eps}`,
      priorBar: { unixTime: bar.unixTime, high: bar.high, low: bar.low },
      mark,
    };
  }

  const out: HourlyBandTickResult = {
    ran: true,
    log: '',
    priorBar: { unixTime: bar.unixTime, high: bar.high, low: bar.low },
    mark,
  };

  if (atHigh && st.shortSigAtCandle == null) {
    const r = await jupiterPerpExecuteMarket({
      side: 'short',
      sizeUsd,
      leverage,
      solPrice: mark,
      asset: 'sol',
      signAndSend: true,
    });
    if (r.ok && 'signature' in r.data) {
      st.shortSigAtCandle = r.data.signature;
      st.updatedAt = nowSec;
      saveState(st);
      out.shortSignature = r.data.signature;
      out.log += ` short ${r.data.signature?.slice(0, 8)}…`;
    } else if (!r.ok) {
      out.log += ` shortErr:${r.error}`;
    }
  }

  if (atLow && st.longSigAtCandle == null) {
    const r = await jupiterPerpExecuteMarket({
      side: 'long',
      sizeUsd,
      leverage,
      solPrice: mark,
      asset: 'sol',
      signAndSend: true,
    });
    if (r.ok && 'signature' in r.data) {
      st.longSigAtCandle = r.data.signature;
      st.updatedAt = nowSec;
      saveState(st);
      out.longSignature = r.data.signature;
      out.log += ` long ${r.data.signature?.slice(0, 8)}…`;
    } else if (!r.ok) {
      out.log += ` longErr:${r.error}`;
    }
  }

  if (!out.log) out.log = 'no new trades (same sig or band miss)';
  return out;
}

export function startHourlyBandSolHeartbeat(): void {
  if (!isHourlyBandSolEnabled()) return;
  const { pollMs } = getConfig();
  const logLine = (r: HourlyBandTickResult) => {
    if (r.ran) console.log(`[hourly-band-sol] ${r.log}`);
  };
  void runHourlyBandSolTick()
    .then(logLine)
    .catch((e) => console.error('[hourly-band-sol]', e));
  setInterval(() => {
    void runHourlyBandSolTick()
      .then(logLine)
      .catch((e) => console.error('[hourly-band-sol]', e));
  }, pollMs);
}
