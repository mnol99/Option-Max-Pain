/**
 * Shared inside-bar strategy step (pattern from candles + price/breakout/exits).
 * Used by /trade client and server tick so simulation advances when the browser sleeps.
 */

import { detectPattern, isBreakoutLong, isBreakoutShort } from '@/lib/solana-bot/pattern-engine';
import {
  createInitialState,
  createPatternDetectedState,
  enterLong,
  enterShort,
  checkPositionExit,
  checkReversedExit,
} from '@/lib/solana-bot/trade-state';
import type { TradeState, ClosedTrade, OHLCVCandle } from '@/lib/solana-bot/types';
import type { StrategyTabDef } from '@/lib/solana-bot/strategy-tabs';
import { strategyUnderlying } from '@/lib/solana-bot/strategy-tabs';
import { isWeekendHalt60mEt } from '@/lib/solana-bot/ibit-schedule';

export interface InsideBarRefs {
  entering: Record<string, boolean>;
  breakout: Record<string, { long: number; short: number }>;
}

function enrichClosedTrades(
  list: ClosedTrade[],
  positionSizeUsd: number,
  asset: 'sol' | 'btc' | 'eth'
): ClosedTrade[] {
  return list.map((closedTrade) => {
    const amt = positionSizeUsd / closedTrade.entryPrice;
    const base = {
      ...closedTrade,
      pnlUsd: (closedTrade.pnlPercent / 100) * positionSizeUsd,
      asset,
    };
    if (asset === 'btc') {
      return { ...base, btcAmount: amt };
    }
    if (asset === 'eth') {
      return { ...base, ethAmount: amt };
    }
    return { ...base, solAmount: amt };
  });
}

/**
 * Update pattern detection from latest candles (idle / pattern_detected / stopped only).
 */
export function applyInsideBarPatternFromCandles(
  strategies: StrategyTabDef[],
  prev: Record<string, TradeState>,
  candlesByStrategy: Record<string, OHLCVCandle[]>,
  refs: InsideBarRefs
): Record<string, TradeState> {
  let next = prev;
  let changed = false;

  for (const s of strategies) {
    const c = candlesByStrategy[s.id] ?? [];
    if (c.length < 4) continue;
    /** Read from initial snapshot only (same as client useEffect). */
    const st = prev[s.id];
    if (!st) continue;
    if (st.status !== 'idle' && st.status !== 'stopped' && st.status !== 'pattern_detected')
      continue;

    const setup = detectPattern(c, s.intervalSec);
    const sameCandleAlreadyTraded =
      setup != null &&
      st.lastTradedCandleUnixTime != null &&
      setup.candleUnixTime === st.lastTradedCandleUnixTime;

    if (!setup || sameCandleAlreadyTraded) {
      if (st.status === 'pattern_detected') {
        if (!changed) {
          next = { ...prev };
          changed = true;
        }
        next[s.id] = {
          ...createInitialState(),
          lastTradedCandleUnixTime: st.lastTradedCandleUnixTime,
        };
      }
      continue;
    }

    const isDoubleInside =
      st.status === 'pattern_detected' &&
      st.setup &&
      st.setup.candleUnixTime !== setup.candleUnixTime;

    if (!changed) {
      next = { ...prev };
      changed = true;
    }
    next[s.id] = {
      ...createPatternDetectedState(setup),
      lastTradedCandleUnixTime: prev[s.id]?.lastTradedCandleUnixTime,
    };
    if (isDoubleInside) refs.breakout[s.id] = { long: 0, short: 0 };
  }

  return changed ? next : prev;
}

export interface InsideBarPriceTickResult {
  stateByStrategy: Record<string, TradeState>;
  refs: InsideBarRefs;
  newTrades: Record<string, ClosedTrade[]>;
}

/**
 * One price tick: breakouts, position management, exits (matches app/trade/page.tsx).
 */
export function applyInsideBarPriceTick(
  strategies: StrategyTabDef[],
  prevState: Record<string, TradeState>,
  refsIn: InsideBarRefs,
  priceByStrategyId: Record<string, number>,
  priceTimeByStrategyId: Record<string, number>,
  positionSizeUsd: number
): InsideBarPriceTickResult {
  const state = { ...prevState };
  const refs: InsideBarRefs = {
    entering: { ...refsIn.entering },
    breakout: { ...refsIn.breakout },
  };
  const newTrades: Record<string, ClosedTrade[]> = {};

  const bcFor = (id: string) => {
    if (!refs.breakout[id]) refs.breakout[id] = { long: 0, short: 0 };
    return refs.breakout[id];
  };

  for (const s of strategies) {
    const sid = s.id;
    let st = state[sid];
    if (!st) continue;

    const price = priceByStrategyId[sid];
    const priceTime = priceTimeByStrategyId[sid];
    if (price == null || priceTime == null) continue;

    /** 60m only: Fri ≥5pm ET → Sun &lt;3pm ET — no new trades; flatten open legs. Daily (tf1d) always runs. */
    if (s.intervalSec === 3600 && isWeekendHalt60mEt(new Date(priceTime * 1000))) {
      if (st.status === 'in_position') {
        const r = checkPositionExit({ ...st, windowEnd: priceTime - 1 }, price, priceTime);
        state[sid] = r.newState;
        if (r.closedTrades.length > 0) {
          newTrades[sid] = enrichClosedTrades(
            r.closedTrades,
            positionSizeUsd,
            strategyUnderlying(s)
          );
        }
        continue;
      }
      if (st.status === 'reversed') {
        const r = checkReversedExit({ ...st, windowEnd: priceTime - 1 }, price, priceTime);
        state[sid] = r.newState;
        if (r.closedTrades.length > 0) {
          newTrades[sid] = enrichClosedTrades(
            r.closedTrades,
            positionSizeUsd,
            strategyUnderlying(s)
          );
        }
        continue;
      }
      if (st.status === 'pattern_detected') {
        state[sid] = {
          ...createInitialState(),
          lastTradedCandleUnixTime: st.lastTradedCandleUnixTime,
        };
        refs.entering[sid] = false;
        refs.breakout[sid] = { long: 0, short: 0 };
      }
      continue;
    }

    if (st.status === 'pattern_detected' && st.setup && !refs.entering[sid]) {
      const setup = st.setup;
      const longBreakout = isBreakoutLong(price, setup);
      const shortBreakout = isBreakoutShort(price, setup);
      const bc = bcFor(sid);

      if (longBreakout) {
        const prevLong = bc.long;
        bc.long += 1;
        bc.short = 0;
        if (prevLong >= 0) {
          refs.entering[sid] = true;
          bc.long = 0;
          bc.short = 0;
          st = enterLong(st, price, priceTime);
          state[sid] = st;
        }
        continue;
      }
      if (shortBreakout) {
        const prevShort = bc.short;
        bc.short += 1;
        bc.long = 0;
        if (prevShort >= 0) {
          refs.entering[sid] = true;
          bc.long = 0;
          bc.short = 0;
          st = enterShort(st, price, priceTime);
          state[sid] = st;
        }
        continue;
      }
      bc.long = 0;
      bc.short = 0;
    }

    if ((st.status === 'idle' || st.status === 'stopped') && refs.entering[sid]) {
      refs.entering[sid] = false;
    }

    if (st.status === 'in_position') {
      const { newState, closedTrades } = checkPositionExit(st, price, priceTime);
      state[sid] = newState;
      if (closedTrades.length > 0) {
        newTrades[sid] = enrichClosedTrades(closedTrades, positionSizeUsd, strategyUnderlying(s));
      }
      continue;
    }

    if (st.status === 'reversed') {
      const { newState, closedTrades } = checkReversedExit(st, price, priceTime);
      state[sid] = newState;
      if (closedTrades.length > 0) {
        newTrades[sid] = enrichClosedTrades(closedTrades, positionSizeUsd, strategyUnderlying(s));
      }
    }
  }

  return { stateByStrategy: state, refs, newTrades };
}

/**
 * Full step: candles then price (order matches client effects).
 */
export function runInsideBarStep(
  strategies: StrategyTabDef[],
  prevState: Record<string, TradeState>,
  refsIn: InsideBarRefs,
  candlesByStrategy: Record<string, OHLCVCandle[]>,
  priceByStrategyId: Record<string, number>,
  priceTimeByStrategyId: Record<string, number>,
  positionSizeUsd: number
): InsideBarPriceTickResult & { stateAfterPattern: Record<string, TradeState> } {
  const refsPattern: InsideBarRefs = {
    entering: { ...refsIn.entering },
    breakout: { ...refsIn.breakout },
  };
  const stateAfterPattern = applyInsideBarPatternFromCandles(
    strategies,
    prevState,
    candlesByStrategy,
    refsPattern
  );
  const afterPrice = applyInsideBarPriceTick(
    strategies,
    stateAfterPattern,
    refsPattern,
    priceByStrategyId,
    priceTimeByStrategyId,
    positionSizeUsd
  );
  return { ...afterPrice, stateAfterPattern };
}
