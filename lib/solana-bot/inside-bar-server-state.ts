/**
 * Server-side inside-bar simulation: advances on /api/solana-bot/inside-bar/tick
 * so 60m/Daily inside-bar logic keeps running while the browser tab is suspended.
 */

import { advanceCandlesOnce, getCandles, getWarmupMinutes } from '@/lib/solana-bot/candle-aggregator';
import { fetchPythPrice } from '@/lib/solana-bot/pyth-price';
import { INSIDE_BAR_STRATEGIES } from '@/lib/solana-bot/strategy-tabs';
import { createInitialState } from '@/lib/solana-bot/trade-state';
import type { TradeState, ClosedTrade, OHLCVCandle } from '@/lib/solana-bot/types';
import {
  runInsideBarStep,
  type InsideBarRefs,
} from '@/lib/solana-bot/inside-bar-engine';

const DEFAULT_POSITION_USD = 1000;

export interface InsideBarServerSnapshot {
  stateByStrategy: Record<string, TradeState>;
  entering: Record<string, boolean>;
  breakout: Record<string, { long: number; short: number }>;
  tradesByStrategy: Record<string, ClosedTrade[]>;
}

let serverState: InsideBarServerSnapshot & { lastTickAt: number } = {
  stateByStrategy: Object.fromEntries(
    INSIDE_BAR_STRATEGIES.map((s) => [s.id, createInitialState()])
  ),
  entering: Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, false])),
  breakout: Object.fromEntries(
    INSIDE_BAR_STRATEGIES.map((s) => [s.id, { long: 0, short: 0 }])
  ),
  tradesByStrategy: Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, [] as ClosedTrade[]])),
  lastTickAt: 0,
};

function mergeClientSnapshot(snap: Partial<InsideBarServerSnapshot>): void {
  if (snap.stateByStrategy) {
    for (const s of INSIDE_BAR_STRATEGIES) {
      const st = snap.stateByStrategy[s.id];
      if (st) serverState.stateByStrategy[s.id] = st;
    }
  }
  if (snap.entering) {
    for (const s of INSIDE_BAR_STRATEGIES) {
      if (snap.entering[s.id] !== undefined) {
        serverState.entering[s.id] = snap.entering[s.id]!;
      }
    }
  }
  if (snap.breakout) {
    for (const s of INSIDE_BAR_STRATEGIES) {
      const b = snap.breakout[s.id];
      if (b) serverState.breakout[s.id] = { ...b };
    }
  }
  if (snap.tradesByStrategy) {
    for (const s of INSIDE_BAR_STRATEGIES) {
      const t = snap.tradesByStrategy[s.id];
      if (t) serverState.tradesByStrategy[s.id] = t;
    }
  }
}

export function getInsideBarServerState(): typeof serverState {
  return serverState;
}

export function resetInsideBarServerState(): void {
  serverState = {
    stateByStrategy: Object.fromEntries(
      INSIDE_BAR_STRATEGIES.map((s) => [s.id, createInitialState()])
    ),
    entering: Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, false])),
    breakout: Object.fromEntries(
      INSIDE_BAR_STRATEGIES.map((s) => [s.id, { long: 0, short: 0 }])
    ),
    tradesByStrategy: Object.fromEntries(
      INSIDE_BAR_STRATEGIES.map((s) => [s.id, [] as ClosedTrade[]])
    ),
    lastTickAt: 0,
  };
}

/** Serialize ticks (OHLC + strategy) so concurrent requests don't interleave. */
let tickChain: Promise<unknown> = Promise.resolve();

export function tickInsideBarServerQueued(
  clientSnapshot: Partial<InsideBarServerSnapshot> | undefined,
  positionSizeUsd: number,
  options?: { useChartPrice?: boolean }
): Promise<{
  snapshot: InsideBarServerSnapshot & { lastTickAt: number };
  price: number;
  priceTime: number;
  candlesByStrategy: Record<string, OHLCVCandle[]>;
  newTrades: Record<string, ClosedTrade[]>;
  warmupByStrategy: Record<string, number>;
}> {
  const task = tickChain.then(() => tickInsideBarServer(clientSnapshot, positionSizeUsd, options));
  tickChain = task.catch(() => {});
  return task;
}

export async function tickInsideBarServer(
  clientSnapshot: Partial<InsideBarServerSnapshot> | undefined,
  positionSizeUsd: number,
  options?: { useChartPrice?: boolean }
): Promise<{
  snapshot: InsideBarServerSnapshot & { lastTickAt: number };
  price: number;
  priceTime: number;
  candlesByStrategy: Record<string, OHLCVCandle[]>;
  newTrades: Record<string, ClosedTrade[]>;
  warmupByStrategy: Record<string, number>;
}> {
  if (clientSnapshot) {
    mergeClientSnapshot(clientSnapshot);
  }

  await advanceCandlesOnce();

  const candlesByStrategy: Record<string, OHLCVCandle[]> = {};
  for (const s of INSIDE_BAR_STRATEGIES) {
    candlesByStrategy[s.id] = getCandles(s.intervalSec);
  }

  const pr = await fetchPythPrice();
  let price = pr.price;
  let priceTime = pr.timestamp;
  if (options?.useChartPrice) {
    const first = INSIDE_BAR_STRATEGIES.map((s) => candlesByStrategy[s.id]?.[0]?.close).find(
      (c) => typeof c === 'number' && c > 0
    );
    if (first != null) {
      price = first;
      priceTime = Math.floor(Date.now() / 1000);
    }
  }

  const refsIn: InsideBarRefs = {
    entering: { ...serverState.entering },
    breakout: { ...serverState.breakout },
  };

  const result = runInsideBarStep(
    INSIDE_BAR_STRATEGIES,
    serverState.stateByStrategy,
    refsIn,
    candlesByStrategy,
    price,
    priceTime,
    positionSizeUsd
  );

  serverState.stateByStrategy = result.stateByStrategy;
  serverState.entering = result.refs.entering;
  serverState.breakout = result.refs.breakout;
  serverState.lastTickAt = Date.now();

  for (const k of Object.keys(result.newTrades)) {
    const list = result.newTrades[k];
    if (list?.length) {
      serverState.tradesByStrategy[k] = [...list, ...(serverState.tradesByStrategy[k] ?? [])];
    }
  }

  const warmupByStrategy: Record<string, number> = {};
  for (const s of INSIDE_BAR_STRATEGIES) {
    warmupByStrategy[s.id] = getWarmupMinutes(s.intervalSec);
  }

  return {
    snapshot: serverState,
    price,
    priceTime,
    candlesByStrategy,
    newTrades: result.newTrades,
    warmupByStrategy,
  };
}

export function getDefaultInsideBarPositionUsd(): number {
  const raw = process.env.INSIDE_BAR_POSITION_USD;
  if (raw == null || raw === '') return DEFAULT_POSITION_USD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_POSITION_USD;
}
