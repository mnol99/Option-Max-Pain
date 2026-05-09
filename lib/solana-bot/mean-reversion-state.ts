/**
 * In-memory positions + bar processing for mean-reversion bot.
 */

import type { OHLCVCandle } from './types';
import type { MeanRevAsset } from './dual-jupiter-candles';
import { candlesOldestFirst, getMeanRevCandles15m, getMeanRevCandles1h } from './dual-jupiter-candles';
import { evaluateMeanReversion, type SpikeContext } from './mean-reversion-engine';
import { logMeanRevEvent } from './mean-reversion-logger';

export interface MeanRevPosition {
  asset: MeanRevAsset;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  sizeUsd: number;
  remainingFraction: number;
  stopPrice: number;
  tp1Price: number;
  tp2Vwap: number;
  tp1Done: boolean;
  entryBarUnix: number;
}

const positions = new Map<MeanRevAsset, MeanRevPosition | null>([
  ['sol', null],
  ['btc', null],
]);

const lastBarProcessed = new Map<MeanRevAsset, number>([
  ['sol', 0],
  ['btc', 0],
]);

/** Last 15m bar unix we ran position management on (avoid double TP on same tick). */
const lastManageBar = new Map<MeanRevAsset, number>([
  ['sol', 0],
  ['btc', 0],
]);

const lastSignalKey = new Map<MeanRevAsset, string>([
  ['sol', ''],
  ['btc', ''],
]);

function accountBalanceUsd(): number {
  const n = Number(process.env.MEAN_REV_ACCOUNT_USD);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

export function getMeanRevAccountUsd(): number {
  return accountBalanceUsd();
}

export function getMeanRevPositionSizeUsd(): number {
  return accountBalanceUsd() * 0.02;
}

function maxOpenPositions(): number {
  return 2;
}

function openCount(): number {
  let n = 0;
  for (const p of Array.from(positions.values())) {
    if (p) n++;
  }
  return n;
}

function pnlShort(entry: number, exit: number, frac: number, notional: number): number {
  return ((entry - exit) / entry) * frac * notional;
}

function pnlLong(entry: number, exit: number, frac: number, notional: number): number {
  return ((exit - entry) / entry) * frac * notional;
}

function processPosition(
  asset: MeanRevAsset,
  pos: MeanRevPosition,
  candle: OHLCVCandle,
  nowSec: number
): { pos: MeanRevPosition | null; events: Array<{ type: string; pnlUsd?: number }> } {
  const events: Array<{ type: string; pnlUsd?: number }> = [];
  let p = { ...pos };
  const high = candle.high;
  const low = candle.low;
  const close = candle.close;

  if (p.direction === 'short') {
    if (high >= p.stopPrice && !p.tp1Done) {
      const loss = pnlShort(p.entryPrice, p.stopPrice, p.remainingFraction, p.sizeUsd);
      void logMeanRevEvent({
        ts: new Date().toISOString(),
        type: 'stop',
        asset,
        direction: 'short',
        entryPrice: p.entryPrice,
        exitPrice: p.stopPrice,
        pnlUsd: loss,
        message: 'stop_loss',
      });
      return { pos: null, events: [{ type: 'stop', pnlUsd: loss }] };
    }
    if (!p.tp1Done && low <= p.tp1Price) {
      const leg = 0.6 * p.sizeUsd;
      const pnl = pnlShort(p.entryPrice, p.tp1Price, 0.6, p.sizeUsd);
      void logMeanRevEvent({
        ts: new Date().toISOString(),
        type: 'tp1',
        asset,
        direction: 'short',
        entryPrice: p.entryPrice,
        exitPrice: p.tp1Price,
        pnlUsd: pnl,
        message: 'tp1_60pct',
      });
      p.tp1Done = true;
      p.remainingFraction = 0.4;
      p.stopPrice = p.entryPrice;
      events.push({ type: 'tp1', pnlUsd: pnl });
      void logMeanRevEvent({
        ts: new Date().toISOString(),
        type: 'breakeven',
        asset,
        direction: 'short',
        message: 'stop_to_breakeven',
      });
    }
    if (p.tp1Done) {
      if (high >= p.stopPrice && p.stopPrice <= p.entryPrice * 1.0001) {
        const pnl = pnlShort(p.entryPrice, p.stopPrice, p.remainingFraction, p.sizeUsd);
        void logMeanRevEvent({
          ts: new Date().toISOString(),
          type: 'exit',
          asset,
          direction: 'short',
          entryPrice: p.entryPrice,
          exitPrice: p.stopPrice,
          pnlUsd: pnl,
          message: 'stopped_breakeven',
        });
        return { pos: null, events: [...events, { type: 'exit', pnlUsd: pnl }] };
      }
      if (low <= p.tp2Vwap) {
        const exitPx = p.tp2Vwap;
        const pnl = pnlShort(p.entryPrice, exitPx, p.remainingFraction, p.sizeUsd);
        void logMeanRevEvent({
          ts: new Date().toISOString(),
          type: 'tp2',
          asset,
          direction: 'short',
          entryPrice: p.entryPrice,
          exitPrice: exitPx,
          pnlUsd: pnl,
          message: 'tp2_vwap',
        });
        return { pos: null, events: [...events, { type: 'tp2', pnlUsd: pnl }] };
      }
    }
  } else {
    if (low <= p.stopPrice && !p.tp1Done) {
      const loss = pnlLong(p.entryPrice, p.stopPrice, p.remainingFraction, p.sizeUsd);
      void logMeanRevEvent({
        ts: new Date().toISOString(),
        type: 'stop',
        asset,
        direction: 'long',
        entryPrice: p.entryPrice,
        exitPrice: p.stopPrice,
        pnlUsd: loss,
        message: 'stop_loss',
      });
      return { pos: null, events: [{ type: 'stop', pnlUsd: loss }] };
    }
    if (!p.tp1Done && high >= p.tp1Price) {
      const pnl = pnlLong(p.entryPrice, p.tp1Price, 0.6, p.sizeUsd);
      void logMeanRevEvent({
        ts: new Date().toISOString(),
        type: 'tp1',
        asset,
        direction: 'long',
        entryPrice: p.entryPrice,
        exitPrice: p.tp1Price,
        pnlUsd: pnl,
        message: 'tp1_60pct',
      });
      p.tp1Done = true;
      p.remainingFraction = 0.4;
      p.stopPrice = p.entryPrice;
      events.push({ type: 'tp1', pnlUsd: pnl });
      void logMeanRevEvent({
        ts: new Date().toISOString(),
        type: 'breakeven',
        asset,
        direction: 'long',
        message: 'stop_to_breakeven',
      });
    }
    if (p.tp1Done) {
      if (low <= p.stopPrice && p.stopPrice >= p.entryPrice * 0.9999) {
        const pnl = pnlLong(p.entryPrice, p.stopPrice, p.remainingFraction, p.sizeUsd);
        void logMeanRevEvent({
          ts: new Date().toISOString(),
          type: 'exit',
          asset,
          direction: 'long',
          entryPrice: p.entryPrice,
          exitPrice: p.stopPrice,
          pnlUsd: pnl,
          message: 'stopped_breakeven',
        });
        return { pos: null, events: [...events, { type: 'exit', pnlUsd: pnl }] };
      }
      if (high >= p.tp2Vwap) {
        const exitPx = p.tp2Vwap;
        const pnl = pnlLong(p.entryPrice, exitPx, p.remainingFraction, p.sizeUsd);
        void logMeanRevEvent({
          ts: new Date().toISOString(),
          type: 'tp2',
          asset,
          direction: 'long',
          entryPrice: p.entryPrice,
          exitPrice: exitPx,
          pnlUsd: pnl,
          message: 'tp2_vwap',
        });
        return { pos: null, events: [...events, { type: 'tp2', pnlUsd: pnl }] };
      }
    }
  }

  return { pos: p, events };
}

const MIN_BARS_FOR_SIGNAL = 51;

export async function tickMeanReversion(): Promise<{
  positions: Record<string, MeanRevPosition | null>;
  lastBar: Record<string, number | null>;
  /** Completed 15m bars stored so far (need 2+ for lastBar, 51+ for entries) */
  completed15mBars: Record<string, number>;
  minBarsForSignal: number;
}> {
  const out: Record<string, MeanRevPosition | null> = {};
  const lastBar: Record<string, number | null> = { sol: null, btc: null };
  const completed15mBars: Record<string, number> = { sol: 0, btc: 0 };

  for (const asset of ['sol', 'btc'] as MeanRevAsset[]) {
    const newestFirst = getMeanRevCandles15m(asset);
    completed15mBars[asset] = newestFirst.length;
    const h1 = candlesOldestFirst(getMeanRevCandles1h(asset));

    if (newestFirst.length === 0) {
      out[asset] = positions.get(asset) ?? null;
      continue;
    }

    const oldest = candlesOldestFirst(newestFirst);
    if (newestFirst.length === 1) {
      lastBar[asset] = oldest[0]!.unixTime;
      out[asset] = positions.get(asset) ?? null;
      continue;
    }

    const lastClosed = oldest[oldest.length - 2]!;
    const lastClosedTs = lastClosed.unixTime;
    lastBar[asset] = lastClosedTs;

    let pos = positions.get(asset) ?? null;
    if (
      pos &&
      pos.entryBarUnix !== lastClosedTs &&
      lastManageBar.get(asset) !== lastClosedTs
    ) {
      lastManageBar.set(asset, lastClosedTs);
      const { pos: next } = processPosition(asset, pos, lastClosed, Math.floor(Date.now() / 1000));
      positions.set(asset, next);
      pos = next;
    }

    if (lastBarProcessed.get(asset) === lastClosedTs) {
      out[asset] = positions.get(asset) ?? null;
      continue;
    }
    lastBarProcessed.set(asset, lastClosedTs);

    if (oldest.length < MIN_BARS_FOR_SIGNAL) {
      out[asset] = positions.get(asset) ?? null;
      continue;
    }

    const lastIdx = oldest.length - 2;
    const ev = evaluateMeanReversion(oldest, lastIdx, { hourlyCandlesOldestFirst: h1 });

    const sigKey = `${lastClosedTs}-${ev?.context.direction ?? 'none'}`;
    if (ev && openCount() < maxOpenPositions() && !positions.get(asset)) {
      if (lastSignalKey.get(asset) !== sigKey) {
        lastSignalKey.set(asset, sigKey);
        const ctx = ev.context;
        const sizeUsd = getMeanRevPositionSizeUsd();
        const newPos: MeanRevPosition = {
          asset,
          direction: ctx.direction,
          entryPrice: lastClosed.close,
          entryTime: Math.floor(Date.now() / 1000),
          sizeUsd,
          remainingFraction: 1,
          stopPrice: ctx.stopPrice,
          tp1Price: ctx.tp1Price,
          tp2Vwap: ctx.tp2Vwap,
          tp1Done: false,
          entryBarUnix: lastClosedTs,
        };
        positions.set(asset, newPos);
        void logMeanRevEvent({
          ts: new Date().toISOString(),
          type: 'signal',
          asset,
          direction: ctx.direction,
          message: ev.reasons.join(','),
          meta: { spikeIndex: ctx.spikeIndex },
        });
        void logMeanRevEvent({
          ts: new Date().toISOString(),
          type: 'entry',
          asset,
          direction: ctx.direction,
          entryPrice: newPos.entryPrice,
          message: 'market_on_confirm_close',
        });
      }
    }

    out[asset] = positions.get(asset) ?? null;
  }

  return {
    positions: out,
    lastBar,
    completed15mBars,
    minBarsForSignal: MIN_BARS_FOR_SIGNAL,
  };
}

export function getMeanRevPositionsSnapshot(): Record<string, MeanRevPosition | null> {
  return {
    sol: positions.get('sol') ?? null,
    btc: positions.get('btc') ?? null,
  };
}
