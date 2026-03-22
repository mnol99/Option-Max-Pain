/**
 * Backtest engine for 5-minute inside-bar pattern
 * Simulates pattern detection, breakout entries, and exits over historical data
 */

import type { OHLCVCandle, PatternSetup } from './types';
import { detectPattern, isBreakoutLong, isBreakoutShort } from './pattern-engine';

export interface SimulatedTrade {
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  exitReason: 'tp' | 'time' | 'stop' | 'reverse';
  entryTime: number;
  exitTime: number;
  pnlPercent: number;
  /** Intended entry (breakout level) - for slippage analysis */
  intendedEntry: number;
  /** Simulated slippage: (entry - intended) for long, (intended - entry) for short */
  slippageBps: number;
  /** Max adverse excursion (drawdown) during trade, in % */
  maePercent: number;
  /** Max favorable excursion (best unrealized) during trade, in % */
  mfePercent: number;
}

export interface DetectedPattern {
  time: number;
  candleUnixTime: number;
  breakoutHigh: number;
  breakoutLow: number;
  range: number;
  triggeredLong: boolean;
  triggeredShort: boolean;
}

export interface BacktestReport {
  startTime: number;
  endTime: number;
  totalCandles: number;
  patternsDetected: number;
  patternsWithBreakout: number;
  patternsMissed: number;
  trades: SimulatedTrade[];
  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnlPercent: number;
  avgPnlPercent: number;
  avgSlippageBps: number;
  avgMaePercent: number;
  avgMfePercent: number;
  byExitReason: Record<string, number>;
  detectedPatterns: DetectedPattern[];
}

/**
 * Simulate trade management for one 5-min window. Uses next candle's OHLC.
 * Assumes: first touch wins. If both TP and stop in range, use order: O -> H -> L -> C.
 * Conservative: if low <= stop for long, assume stop hit first (worse case).
 */
function simulateTradeWindow(
  setup: PatternSetup,
  side: 'long' | 'short',
  nextCandle: OHLCVCandle,
  entryTime: number
): { exitPrice: number; exitReason: 'tp' | 'time' | 'stop' | 'reverse'; exitTime: number } {
  const { open, high, low, close } = nextCandle;
  const exitTime = nextCandle.unixTime + 300;

  if (side === 'long') {
    if (low <= setup.breakoutLow) {
      return { exitPrice: setup.breakoutLow, exitReason: 'reverse', exitTime };
    }
    if (high >= setup.tpLong) {
      return { exitPrice: setup.tpLong, exitReason: 'tp', exitTime };
    }
    return { exitPrice: close, exitReason: 'time', exitTime };
  } else {
    if (high >= setup.breakoutHigh) {
      return { exitPrice: setup.breakoutHigh, exitReason: 'reverse', exitTime };
    }
    if (low <= setup.tpShort) {
      return { exitPrice: setup.tpShort, exitReason: 'tp', exitTime };
    }
    return { exitPrice: close, exitReason: 'time', exitTime };
  }
}

export function runBacktest(candles: OHLCVCandle[]): BacktestReport {
  if (candles.length < 5) {
    return {
      startTime: 0,
      endTime: 0,
      totalCandles: candles.length,
      patternsDetected: 0,
      patternsWithBreakout: 0,
      patternsMissed: 0,
      trades: [],
      tradeCount: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      totalPnlPercent: 0,
      avgPnlPercent: 0,
      avgSlippageBps: 0,
      avgMaePercent: 0,
      avgMfePercent: 0,
      byExitReason: {},
      detectedPatterns: [],
    };
  }

  // Sort oldest first for sequential backtest
  const sorted = [...candles].sort((a, b) => a.unixTime - b.unixTime);

  const trades: SimulatedTrade[] = [];
  const detectedPatterns: DetectedPattern[] = [];
  const byExitReason: Record<string, number> = { tp: 0, time: 0, stop: 0, reverse: 0 };

  let patternsDetected = 0;
  let patternsWithBreakout = 0;
  let setup: PatternSetup | null = null;
  let setupCandleIndex = -1;

  for (let i = 3; i < sorted.length - 1; i++) {
    const window = [sorted[i], sorted[i - 1], sorted[i - 2], sorted[i - 3]];
    const detected = detectPattern(window);

    if (detected) {
      const isDoubleInside = setup && detected.candleUnixTime !== setup.candleUnixTime;
      if (!setup || isDoubleInside) {
        patternsDetected++;
        setup = { ...detected, candleUnixTime: sorted[i].unixTime };
        setupCandleIndex = i;
      }
    }

    if (setup) {
      const nextCandle = sorted[i + 1];
      const open = nextCandle.open;
      const high = nextCandle.high;
      const low = nextCandle.low;

      const triggeredLong = isBreakoutLong(open, setup) || high > setup.breakoutHigh;
      const triggeredShort = isBreakoutShort(open, setup) || low < setup.breakoutLow;

      const lastRecorded = detectedPatterns[detectedPatterns.length - 1];
      if (!lastRecorded || lastRecorded.candleUnixTime !== (setup.candleUnixTime ?? 0)) {
        detectedPatterns.push({
          time: sorted[setupCandleIndex].unixTime + 300,
          candleUnixTime: setup.candleUnixTime ?? 0,
          breakoutHigh: setup.breakoutHigh,
          breakoutLow: setup.breakoutLow,
          range: setup.range,
          triggeredLong,
          triggeredShort,
        });
      }

      // Which triggers first? Use open then high then low within the bar
      let side: 'long' | 'short' | null = null;
      let entryPrice = 0;
      const intendedLong = setup.breakoutHigh;
      const intendedShort = setup.breakoutLow;

      if (open > setup.breakoutHigh) {
        side = 'long';
        entryPrice = open;
      } else if (open < setup.breakoutLow) {
        side = 'short';
        entryPrice = open;
      } else {
        if (high > setup.breakoutHigh && low < setup.breakoutLow) {
          const distToLong = setup.breakoutHigh - open;
          const distToShort = open - setup.breakoutLow;
          side = distToLong < distToShort ? 'long' : 'short';
          entryPrice = side === 'long' ? setup.breakoutHigh : setup.breakoutLow;
        } else if (high > setup.breakoutHigh) {
          side = 'long';
          entryPrice = setup.breakoutHigh;
        } else if (low < setup.breakoutLow) {
          side = 'short';
          entryPrice = setup.breakoutLow;
        }
      }

      if (side) {
        patternsWithBreakout++;
        const { exitPrice, exitReason, exitTime } = simulateTradeWindow(
          setup,
          side,
          nextCandle,
          sorted[i].unixTime + 300
        );

        const intendedEntry = side === 'long' ? intendedLong : intendedShort;
        const pnlPercent =
          side === 'long'
            ? ((exitPrice - entryPrice) / entryPrice) * 100
            : ((entryPrice - exitPrice) / entryPrice) * 100;

        const slippageBps =
          side === 'long'
            ? ((entryPrice - intendedEntry) / intendedEntry) * 10000
            : ((intendedEntry - entryPrice) / intendedEntry) * 10000;

        const maePercent =
          side === 'long'
            ? Math.min(0, ((nextCandle.low - entryPrice) / entryPrice) * 100)
            : Math.min(0, ((entryPrice - nextCandle.high) / entryPrice) * 100);
        const mfePercent =
          side === 'long'
            ? Math.max(0, ((nextCandle.high - entryPrice) / entryPrice) * 100)
            : Math.max(0, ((entryPrice - nextCandle.low) / entryPrice) * 100);

        byExitReason[exitReason] = (byExitReason[exitReason] || 0) + 1;

        trades.push({
          side,
          entryPrice,
          exitPrice,
          exitReason,
          entryTime: nextCandle.unixTime,
          exitTime,
          pnlPercent,
          intendedEntry,
          slippageBps,
          maePercent,
          mfePercent,
        });

        setup = null;
      }
    }
  }

  const winCount = trades.filter((t) => t.pnlPercent > 0).length;
  const lossCount = trades.filter((t) => t.pnlPercent <= 0).length;
  const totalPnlPercent = trades.reduce((s, t) => s + t.pnlPercent, 0);

  return {
    startTime: sorted[0]?.unixTime ?? 0,
    endTime: sorted[sorted.length - 1]?.unixTime ?? 0,
    totalCandles: sorted.length,
    patternsDetected,
    patternsWithBreakout,
    patternsMissed: patternsDetected - patternsWithBreakout,
    trades,
    tradeCount: trades.length,
    winCount,
    lossCount,
    winRate: trades.length > 0 ? (winCount / trades.length) * 100 : 0,
    totalPnlPercent,
    avgPnlPercent: trades.length > 0 ? totalPnlPercent / trades.length : 0,
    avgSlippageBps:
      trades.length > 0
        ? trades.reduce((s, t) => s + t.slippageBps, 0) / trades.length
        : 0,
    avgMaePercent:
      trades.length > 0 ? trades.reduce((s, t) => s + t.maePercent, 0) / trades.length : 0,
    avgMfePercent:
      trades.length > 0 ? trades.reduce((s, t) => s + t.mfePercent, 0) / trades.length : 0,
    byExitReason,
    detectedPatterns,
  };
}
