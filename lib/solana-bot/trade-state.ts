/**
 * Trade state machine and PnL tracking
 * Manages pattern -> breakout -> position -> exit flow
 */

import type {
  PatternSetup,
  TradeState,
  TradeStatus,
  PositionSide,
  ClosedTrade,
  TradeMetrics,
} from './types';
import { isBreakoutLong, isBreakoutShort } from './pattern-engine';

const TICK = 0.01;
/** Min TP distance (in price) to cover round-trip fees (~0.20% of notional vs $1000 baseline) */
const FEE_MIN_BPS = 20;

/** Seconds from entry until time exit if TP/stop not hit (10 minutes) */
export const POSITION_MANAGEMENT_SEC = 600;

/** Jupiter Perps taker fee (approx.); used for performance “total cost” estimate */
export const JUPITER_PERPS_EST_FEE_BPS_PER_SIDE = 6;

function closedTradeNotionalUsd(t: ClosedTrade): number {
  if (t.solAmount != null && t.entryPrice > 0) {
    return t.solAmount * t.entryPrice;
  }
  if (t.pnlUsd != null && Math.abs(t.pnlPercent) > 1e-8) {
    return t.pnlUsd / (t.pnlPercent / 100);
  }
  return 0;
}

/** Effective TP = entry ± max(range, fee min). Export for UI display. */
export function getEffectiveTpLong(entry: number, range: number): number {
  const feeMin = entry * (FEE_MIN_BPS / 10000);
  return entry + Math.max(range, feeMin);
}

export function getEffectiveTpShort(entry: number, range: number): number {
  const feeMin = entry * (FEE_MIN_BPS / 10000);
  return entry - Math.max(range, feeMin);
}

export function createInitialState(): TradeState {
  return {
    status: 'idle',
    position: null,
    setup: null,
    entryPrice: null,
    entryTime: null,
    windowEnd: null,
    stopEventCount: 0,
  };
}

export function createPatternDetectedState(setup: PatternSetup): TradeState {
  return {
    status: 'pattern_detected',
    position: null,
    setup,
    entryPrice: null,
    entryTime: null,
    windowEnd: null,
    stopEventCount: 0,
  };
}

export function enterLong(
  state: TradeState,
  price: number,
  timestamp: number
): TradeState {
  if (!state.setup || state.status !== 'pattern_detected') return state;
  return {
    ...state,
    status: 'in_position',
    position: 'long',
    entryPrice: price,
    entryTime: timestamp,
    windowEnd: timestamp + POSITION_MANAGEMENT_SEC,
    stopEventCount: 0,
  };
}

export function enterShort(
  state: TradeState,
  price: number,
  timestamp: number
): TradeState {
  if (!state.setup || state.status !== 'pattern_detected') return state;
  return {
    ...state,
    status: 'in_position',
    position: 'short',
    entryPrice: price,
    entryTime: timestamp,
    windowEnd: timestamp + POSITION_MANAGEMENT_SEC,
    stopEventCount: 0,
  };
}

export function checkPositionExit(
  state: TradeState,
  price: number,
  timestamp: number
): { newState: TradeState; closedTrade?: ClosedTrade } {
  if (state.status !== 'in_position' || !state.setup || !state.entryPrice)
    return { newState: state };

  const { setup, position, entryPrice, entryTime, windowEnd, stopEventCount } = state;
  if (!windowEnd || !entryTime) return { newState: state };

  const effectiveTpLong = getEffectiveTpLong(entryPrice, setup.range);
  const effectiveTpShort = getEffectiveTpShort(entryPrice, setup.range);
  const liquidationPrice = position === 'long' ? effectiveTpLong : effectiveTpShort;
  const auditSetup = {
    breakoutHigh: setup.breakoutHigh,
    breakoutLow: setup.breakoutLow,
    range: setup.range,
    tpLong: setup.tpLong,
    tpShort: setup.tpShort,
    candleUnixTime: setup.candleUnixTime,
  };

  // Time exit
  if (timestamp >= windowEnd) {
    const pnl =
      position === 'long' ? price - entryPrice : entryPrice - price;
    const pnlPercent = (pnl / entryPrice) * 100;
    return {
      newState: {
        ...state,
        status: 'idle',
        position: null,
        setup: null,
        entryPrice: null,
        entryTime: null,
        windowEnd: null,
        lastTradedCandleUnixTime: setup.candleUnixTime,
      },
      closedTrade: {
        id: `trade-${Date.now()}`,
        side: position,
        entryPrice,
        entryTime,
        exitPrice: price,
        exitTime: timestamp,
        exitReason: 'time',
        liquidationPrice,
        pnl,
        pnlPercent,
        setup: auditSetup,
      },
    };
  }

  if (position === 'long') {
    // TP hit - only exit at TP when it would be profitable (entry < effectiveTp)
    if (price >= effectiveTpLong && effectiveTpLong > entryPrice) {
      const pnl = effectiveTpLong - entryPrice;
      const pnlPercent = (pnl / entryPrice) * 100;
      return {
        newState: {
          ...state,
          status: 'idle',
          position: null,
          setup: null,
          entryPrice: null,
          entryTime: null,
          windowEnd: null,
          lastTradedCandleUnixTime: setup.candleUnixTime,
        },
        closedTrade: {
          id: `trade-${Date.now()}`,
          side: 'long',
          entryPrice,
          entryTime: state.entryTime!,
          exitPrice: effectiveTpLong,
          exitTime: timestamp,
          exitReason: 'tp',
          liquidationPrice: effectiveTpLong,
          pnl,
          pnlPercent,
          setup: auditSetup,
        },
      };
    }
    // Stop and reverse: break below low
    if (price < setup.breakoutLow) {
      return {
        newState: {
          ...state,
          status: 'reversed',
          position: 'short',
          entryPrice: price,
          entryTime: timestamp,
          windowEnd: timestamp + POSITION_MANAGEMENT_SEC,
          stopEventCount: stopEventCount + 1,
        },
      };
    }
  }

  if (position === 'short') {
    // TP hit - only exit at TP when it would be profitable (entry > effectiveTp)
    if (price <= effectiveTpShort && effectiveTpShort < entryPrice) {
      const pnl = entryPrice - effectiveTpShort;
      const pnlPercent = (pnl / entryPrice) * 100;
      return {
        newState: {
          ...state,
          status: 'idle',
          position: null,
          setup: null,
          entryPrice: null,
          entryTime: null,
          windowEnd: null,
          lastTradedCandleUnixTime: setup.candleUnixTime,
        },
        closedTrade: {
          id: `trade-${Date.now()}`,
          side: 'short',
          entryPrice,
          entryTime: state.entryTime!,
          exitPrice: effectiveTpShort,
          exitTime: timestamp,
          exitReason: 'tp',
          liquidationPrice: effectiveTpShort,
          pnl,
          pnlPercent,
          setup: auditSetup,
        },
      };
    }
    // Stop and reverse: break above high
    if (price > setup.breakoutHigh) {
      return {
        newState: {
          ...state,
          status: 'reversed',
          position: 'long',
          entryPrice: price,
          entryTime: timestamp,
          windowEnd: timestamp + POSITION_MANAGEMENT_SEC,
          stopEventCount: stopEventCount + 1,
        },
      };
    }
  }

  return { newState: state };
}

export function checkReversedExit(
  state: TradeState,
  price: number,
  timestamp: number
): { newState: TradeState; closedTrade?: ClosedTrade } {
  if (state.status !== 'reversed' || !state.setup || !state.entryPrice)
    return { newState: state };

  const { setup, position, entryPrice, entryTime, windowEnd, stopEventCount } = state;
  if (!windowEnd || !entryTime) return { newState: state };

  const effectiveTpLong = getEffectiveTpLong(entryPrice, setup.range);
  const effectiveTpShort = getEffectiveTpShort(entryPrice, setup.range);
  const liquidationPrice = position === 'long' ? effectiveTpLong : effectiveTpShort;
  const auditSetup = {
    breakoutHigh: setup.breakoutHigh,
    breakoutLow: setup.breakoutLow,
    range: setup.range,
    tpLong: setup.tpLong,
    tpShort: setup.tpShort,
    candleUnixTime: setup.candleUnixTime,
  };

  // Circuit breaker: max 2 stop events
  if (stopEventCount >= 2) {
    return {
      newState: {
        ...state,
        status: 'stopped',
        position: null,
        setup: null,
        entryPrice: null,
        entryTime: null,
        windowEnd: null,
      },
    };
  }

  // Time exit for reversed position
  if (timestamp >= windowEnd) {
    const pnl =
      position === 'long' ? price - entryPrice : entryPrice - price;
    const pnlPercent = (pnl / entryPrice) * 100;
    return {
      newState: {
        ...state,
        status: 'idle',
        position: null,
        setup: null,
        entryPrice: null,
        entryTime: null,
        windowEnd: null,
        lastTradedCandleUnixTime: setup.candleUnixTime,
      },
      closedTrade: {
        id: `trade-${Date.now()}`,
        side: position,
        entryPrice,
        entryTime,
        exitPrice: price,
        exitTime: timestamp,
        exitReason: 'time',
        liquidationPrice,
        pnl,
        pnlPercent,
        setup: auditSetup,
      },
    };
  }

  if (position === 'long') {
    // TP - only when profitable (fee-adjusted)
    if (price >= effectiveTpLong && effectiveTpLong > entryPrice) {
      const pnl = effectiveTpLong - entryPrice;
      const pnlPercent = (pnl / entryPrice) * 100;
      return {
        newState: {
          ...state,
          status: 'idle',
          position: null,
          setup: null,
          entryPrice: null,
          entryTime: null,
          windowEnd: null,
          lastTradedCandleUnixTime: setup.candleUnixTime,
        },
        closedTrade: {
          id: `trade-${Date.now()}`,
          side: 'long',
          entryPrice,
          entryTime,
          exitPrice: effectiveTpLong,
          exitTime: timestamp,
          exitReason: 'tp',
          liquidationPrice: effectiveTpLong,
          pnl,
          pnlPercent,
          setup: auditSetup,
        },
      };
    }
    // Stop out (sell stop at setup.stopLong)
    if (price <= setup.stopLong) {
      const pnl = setup.stopLong - entryPrice;
      const pnlPercent = (pnl / entryPrice) * 100;
      return {
        newState: {
          ...state,
          status: 'stopped',
          position: null,
          setup: null,
          entryPrice: null,
          entryTime: null,
          windowEnd: null,
          stopEventCount: stopEventCount + 1,
          lastTradedCandleUnixTime: setup.candleUnixTime,
        },
        closedTrade: {
          id: `trade-${Date.now()}`,
          side: 'long',
          entryPrice,
          entryTime,
          exitPrice: setup.stopLong,
          exitTime: timestamp,
          exitReason: 'stop',
          liquidationPrice: setup.tpLong,
          pnl,
          pnlPercent,
          setup: auditSetup,
        },
      };
    }
  }

  if (position === 'short') {
    // TP - only when profitable (fee-adjusted)
    if (price <= effectiveTpShort && effectiveTpShort < entryPrice) {
      const pnl = entryPrice - effectiveTpShort;
      const pnlPercent = (pnl / entryPrice) * 100;
      return {
        newState: {
          ...state,
          status: 'idle',
          position: null,
          setup: null,
          entryPrice: null,
          entryTime: null,
          windowEnd: null,
          lastTradedCandleUnixTime: setup.candleUnixTime,
        },
        closedTrade: {
          id: `trade-${Date.now()}`,
          side: 'short',
          entryPrice,
          entryTime,
          exitPrice: effectiveTpShort,
          exitTime: timestamp,
          exitReason: 'tp',
          liquidationPrice: effectiveTpShort,
          pnl,
          pnlPercent,
          setup: auditSetup,
        },
      };
    }
    // Stop out (buy stop at setup.stopShort)
    if (price >= setup.stopShort) {
      const pnl = entryPrice - setup.stopShort;
      const pnlPercent = (pnl / entryPrice) * 100;
      return {
        newState: {
          ...state,
          status: 'stopped',
          position: null,
          setup: null,
          entryPrice: null,
          entryTime: null,
          windowEnd: null,
          stopEventCount: stopEventCount + 1,
          lastTradedCandleUnixTime: setup.candleUnixTime,
        },
        closedTrade: {
          id: `trade-${Date.now()}`,
          side: 'short',
          entryPrice,
          entryTime,
          exitPrice: setup.stopShort,
          exitTime: timestamp,
          exitReason: 'stop',
          liquidationPrice: setup.tpShort,
          pnl,
          pnlPercent,
          setup: auditSetup,
        },
      };
    }
  }

  return { newState: state };
}

export function computeMetrics(trades: ClosedTrade[]): TradeMetrics {
  const total = trades.length;
  if (total === 0) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      winRate: 0,
      sharpeRatio: 0,
      estimatedTotalFeesUsd: 0,
      feeLegCount: 0,
    };
  }
  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl <= 0).length;
  const totalPnl = trades.reduce(
    (s, t) => s + (t.pnlUsd != null ? t.pnlUsd : t.pnl),
    0
  );
  const returns = trades.map((t) => t.pnlPercent / 100);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const std = Math.sqrt(variance) || 1e-10;
  // Annualized: ~288 5m periods per day, 252 trading days
  const periodsPerYear = 288 * 252;
  const sharpeRatio = (mean / std) * Math.sqrt(periodsPerYear);

  const feeRate = JUPITER_PERPS_EST_FEE_BPS_PER_SIDE / 10000;
  let estimatedTotalFeesUsd = 0;
  for (const t of trades) {
    const notional = closedTradeNotionalUsd(t);
    estimatedTotalFeesUsd += 2 * notional * feeRate;
  }
  const feeLegCount = total * 2;

  return {
    totalTrades: total,
    wins,
    losses,
    totalPnl,
    winRate: total > 0 ? (wins / total) * 100 : 0,
    sharpeRatio: std > 0 ? sharpeRatio : 0,
    estimatedTotalFeesUsd,
    feeLegCount,
  };
}
