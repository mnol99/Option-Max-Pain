/**
 * Per-hour: cancel prior band orders, set leverage, place buy limit at prior hour low + sell limit at prior hour high.
 * Notional = HL_COLLATERAL_USD * HL_LEVERAGE; size in coin = notional / mark (approx).
 */

import { cancel } from '@nktkas/hyperliquid/api/exchange';
import fs from 'node:fs';
import path from 'node:path';
import {
  getHourlyAfterMinute,
  getHourlyCoin,
  getHourlyCollateralUsd,
  getHourlyCrossMargin,
  getHourlyLeverage,
  getHourlyUseUtcCandles,
  getHyperliquidUserAddress,
  isHyperliquidHourlyEnabled,
} from '@/lib/hyperliquid/config';
import { getHyperliquidClients, clearHyperliquidClientsCache } from '@/lib/hyperliquid/hl-clients';
import { getHlUiConfig } from '@/lib/hyperliquid/ui-config';
import { formatSizeForHl } from '@/lib/hyperliquid/hl-order-utils';

const STATE_DIR = path.join(process.cwd(), '.data');
const STATE_FILE = 'hl-hourly-bands.json';

export interface HlHourlyState {
  v: 1;
  /** Start of UTC hour we last booked a placement attempt — stops heartbeat from re-submitting until next hour even if HL calls fail mid-run. */
  lastPlacedHourStartMs: number | null;
  lastRunMs: number | null;
  lastError: string | null;
  /** Last successful placement refs (audit / UI); only set when both orders acknowledged. */
  lastRefHigh: string | null;
  lastRefLow: string | null;
  lastBuyOid: number | null;
  lastSellOid: number | null;
  lastPlacedAtMs: number | null;
}

let memState: HlHourlyState = {
  v: 1,
  lastPlacedHourStartMs: null,
  lastRunMs: null,
  lastError: null,
  lastRefHigh: null,
  lastRefLow: null,
  lastBuyOid: null,
  lastSellOid: null,
  lastPlacedAtMs: null,
};

function statePath(): string {
  return path.join(STATE_DIR, STATE_FILE);
}

function loadState(): void {
  try {
    if (!fs.existsSync(statePath())) return;
    const raw = fs.readFileSync(statePath(), 'utf8');
    const p = JSON.parse(raw) as HlHourlyState;
    if (p.v === 1) memState = { ...memState, ...p };
  } catch {
    /* ignore */
  }
}

function saveState(): void {
  try {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${statePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(memState, null, 0), 'utf8');
    fs.renameSync(tmp, statePath());
  } catch {
    /* ignore */
  }
}

function utcHourStartMs(ts: number): number {
  const d = new Date(ts);
  d.setUTCHours(d.getUTCHours(), 0, 0, 0);
  return d.getTime();
}

/** HL `statuses` row is success if it has `resting` or `filled` (not bare `error`). */
function hyperliquidOrderLegOk(s: unknown): boolean {
  if (!s || typeof s !== 'object') return false;
  const x = s as Record<string, unknown>;
  return 'resting' in x || 'filled' in x;
}

export function getHourlyStateSnapshot(): HlHourlyState & {
  enabled: boolean;
  runEnabled: boolean;
} {
  loadState();
  const runEnabled = getHlUiConfig().enabled === true;
  return {
    ...memState,
    enabled: isHyperliquidHourlyEnabled() || runEnabled,
    runEnabled,
  };
}

/**
 * One tick: run if enabled, key not yet placed, and past `after` minute in UTC.
 * @param opts.bypassMinuteGate - for "Try tick now" / debug: do not require UTC minute >= afterMin
 */
export async function runHyperliquidHourlyTick(opts?: { bypassMinuteGate?: boolean }): Promise<{
  ok: boolean;
  skipped?: string;
  error?: string;
  detail?: string;
}> {
  const ui = getHlUiConfig();
  if (ui.enabled === false) {
    return { ok: true, skipped: 'paused via /hyperliquid' };
  }
  if (!isHyperliquidHourlyEnabled() && ui.enabled !== true) {
    return { ok: true, skipped: 'Set HL_HOURLY_BANDS_ENABLED=1 or enable in /hyperliquid' };
  }
  if (!getHourlyUseUtcCandles()) {
    return { ok: true, skipped: 'non-UTC hour candles not implemented; set HL_HOURLY_UTC=1' };
  }

  const clients = getHyperliquidClients();
  if (!clients.ok) {
    return { ok: false, error: clients.error };
  }
  const { info, exchange, wallet } = clients;

  const now = Date.now();
  const nowDt = new Date(now);
  const afterMin = ui.afterMinute ?? getHourlyAfterMinute();
  if (!opts?.bypassMinuteGate && nowDt.getUTCMinutes() < afterMin) {
    const s = { ok: true as const, skipped: `wait until :${String(afterMin).padStart(2, '0')} UTC` };
    console.log('[hl-hourly]', s.skipped, `(now ${nowDt.toISOString()})`);
    return s;
  }

  const hs = utcHourStartMs(now);
  loadState();
  if (memState.lastPlacedHourStartMs === hs) {
    const s = { ok: true as const, skipped: 'already placed this hour' };
    console.log('[hl-hourly]', s.skipped, `hs=${new Date(hs).toISOString()}`);
    return s;
  }

  /**
   * Book this UTC hour immediately so heartbeat/API retries cannot cancel+re-submit every interval
   * when a downstream step fails after one order rests (skewed resting sell-only loop).
   */
  memState = { ...memState, lastPlacedHourStartMs: hs, lastRunMs: now, lastError: null };
  saveState();

    const coin = (ui.coin?.trim().toUpperCase() || getHourlyCoin());
    const collateral = ui.collateralUsd ?? getHourlyCollateralUsd();
    const leverage = ui.leverage ?? getHourlyLeverage();
  const isCross = getHourlyCrossMargin();

  try {
    const m = await info.meta();
    const uidx = m.universe.findIndex((u) => u.name === coin);
    if (uidx < 0) {
      return { ok: false, error: `Unknown perp symbol in meta: ${coin}` };
    }
    const szDec = m.universe[uidx]!.szDecimals;
    const maxLev = m.universe[uidx]!.maxLeverage;
    const useLev = Math.min(maxLev, Math.max(1, Math.round(leverage)));

    const assetCtxs = (await info.metaAndAssetCtxs())[1];
    const markStr = assetCtxs[uidx]?.markPx;
    if (!markStr) {
      return { ok: false, error: 'Could not read mark price from metaAndAssetCtxs' };
    }
    const mark = Number(markStr);
    if (!(mark > 0)) {
      return { ok: false, error: 'Invalid mark' };
    }

    const notional = collateral * useLev;
    const rawSz = notional / mark;
    const sz = formatSizeForHl(rawSz, szDec);
    if (Number(sz) <= 0) {
      return { ok: false, error: 'Computed order size is zero; raise collateral or check mark' };
    }

    const refStart = hs - 60 * 60 * 1000;
    const candles = await info.candleSnapshot({
      coin,
      interval: '1h',
      startTime: refStart,
      endTime: hs,
    });
    const c =
      candles.find((x) => x.t === refStart) ??
      (candles.length > 0 ? candles[candles.length - 1]! : null);
    if (!c) {
      const err = 'No 1h candle for previous hour';
      memState = { ...memState, lastError: err };
      saveState();
      return { ok: false, error: err };
    }
    const hi = Number(c.h);
    const lo = Number(c.l);
    if (!(hi > lo) || !(lo > 0)) {
      const err = 'Invalid high/low';
      memState = { ...memState, lastError: err };
      saveState();
      return { ok: false, error: err };
    }

    const userAddr = getHyperliquidUserAddress() ?? wallet.address;
    const open = await info.frontendOpenOrders({ user: userAddr, dex: '' });
    const toCancel = open.filter((o) => o.coin === coin).map((o) => ({ a: uidx, o: o.oid }));
    if (toCancel.length > 0) {
      await cancel({ transport: clients.transport, wallet: clients.wallet }, { cancels: toCancel });
    }

    await exchange.updateLeverage({ asset: uidx, isCross, leverage: useLev });

    const orderRes = await exchange.order({
      orders: [
        {
          a: uidx,
          b: true,
          p: String(lo),
          s: sz,
          r: false,
          t: { limit: { tif: 'Gtc' } },
        },
        {
          a: uidx,
          b: false,
          p: String(hi),
          s: sz,
          r: false,
          t: { limit: { tif: 'Gtc' } },
        },
      ],
      grouping: 'na',
    });

    /** Require both HL legs to acknowledge; otherwise we would “succeed” with one resting ask and retry spam. */
    const statuses =
      orderRes.status === 'ok' && orderRes.response?.type === 'order'
        ? orderRes.response.data?.statuses
        : undefined;
    if (!statuses || statuses.length !== 2) {
      const err =
        orderRes.status !== 'ok'
          ? `exchange.order failed (${String(orderRes.status)})`
          : 'Unexpected order statuses length';
      memState = { ...memState, lastError: err };
      saveState();
      return { ok: false, error: err };
    }
    const errs: string[] = [];
    for (const row of statuses) {
      if (row && typeof row === 'object' && 'error' in row) {
        errs.push(String((row as { error: string }).error));
      }
    }
    if (errs.length) {
      const err = errs.join('; ');
      memState = { ...memState, lastError: err };
      saveState();
      return { ok: false, error: err };
    }
    if (!statuses.every(hyperliquidOrderLegOk)) {
      const err = 'HL did not acknowledge both band orders (avoid partial-resting-loop)';
      memState = { ...memState, lastError: err };
      saveState();
      return { ok: false, error: err };
    }

    const open2 = await info.frontendOpenOrders({ user: userAddr, dex: '' });
    const b = open2.find((o) => o.coin === coin && o.side === 'B');
    const a = open2.find((o) => o.coin === coin && o.side === 'A');

    memState = {
      ...memState,
      lastRunMs: now,
      lastError: null,
      lastRefHigh: String(hi),
      lastRefLow: String(lo),
      lastBuyOid: b?.oid ?? null,
      lastSellOid: a?.oid ?? null,
      lastPlacedAtMs: now,
    };
    saveState();
    const det = `${coin} buy@${lo} sell@${hi} sz=${sz} ~$${notional.toFixed(2)} notional lev=${useLev}×`;
    console.log('[hl-hourly] ok', det, nowDt.toISOString());
    return { ok: true, detail: det };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    memState = { ...memState, lastRunMs: now, lastError: msg };
    saveState();
    console.error('[hl-hourly] error', msg);
    return { ok: false, error: msg };
  }
}

export function clearHourlyStateForTests(): void {
  clearHyperliquidClientsCache();
  memState = {
    v: 1,
    lastPlacedHourStartMs: null,
    lastRunMs: null,
    lastError: null,
    lastRefHigh: null,
    lastRefLow: null,
    lastBuyOid: null,
    lastSellOid: null,
    lastPlacedAtMs: null,
  };
}
