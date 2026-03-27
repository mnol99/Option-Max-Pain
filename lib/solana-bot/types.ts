/**
 * Solana Trading Bot - Type definitions
 * Inside bar + smallest range pattern with breakout triggers
 */

export interface OHLCVCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  unixTime: number;
}

export interface PatternSetup {
  /** Timestamp when pattern was detected (candle close) */
  detectedAt: number;
  /** Inside bar high - break above = long trigger */
  breakoutHigh: number;
  /** Inside bar low - break below = short trigger */
  breakoutLow: number;
  /** Range (high - low) of inside bar */
  range: number;
  /** Take-profit price when long: breakoutHigh + range */
  tpLong: number;
  /** Take-profit price when short: breakoutLow - range */
  tpShort: number;
  /** Sell stop when reversed to short: breakoutHigh + 0.01 (tick) */
  stopShort: number;
  /** Buy stop when reversed to long: breakoutLow - 0.01 (tick) */
  stopLong: number;
  /** Candle period end (e.g. 12:10) */
  periodEnd: number;
  /** Candle start (unix) - matches first row in Recent Candles */
  candleUnixTime?: number;
  /** Bar length in seconds (300 = 5m, 600 = 10m, 3600 = 1h) */
  barDurationSec: number;
}

export type PositionSide = 'long' | 'short' | null;

export type TradeStatus =
  | 'idle'           // Waiting for pattern
  | 'pattern_detected' // Pattern found, monitoring for breakout
  | 'in_position'    // In trade, monitoring TP/stop/time
  | 'reversed'       // Stopped and reversed
  | 'stopped'        // Circuit breaker - 2 stops hit
  | 'closed';        // Position closed (TP or time exit)

export interface TradeState {
  status: TradeStatus;
  position: PositionSide;
  setup: PatternSetup | null;
  entryPrice: number | null;
  entryTime: number | null;
  /** Management window end (time exit if TP/stop not hit) */
  windowEnd: number | null;
  /** Seconds from entry to time exit (2 × bar length for this strategy) */
  timeWindowSec: number;
  /** Stop event count (max 2) */
  stopEventCount: number;
  /** Don't re-enter same pattern (candle we just traded) */
  lastTradedCandleUnixTime?: number;
}

export interface ClosedTrade {
  id: string;
  side: PositionSide;
  entryPrice: number;
  /** Entry timestamp (unix seconds) */
  entryTime: number;
  exitPrice: number;
  exitTime: number;
  exitReason: 'tp' | 'time' | 'stop' | 'reverse';
  /** Take-profit / liquidation target price */
  liquidationPrice: number;
  pnl: number;
  pnlPercent: number;
  /** Dollar PnL (paper/live): (pnlPercent/100) * positionSizeUsd */
  pnlUsd?: number;
  /** SOL notional size (positionSizeUsd / entryPrice) */
  solAmount?: number;
  /** Pattern setup for audit (breakout levels, TP targets) */
  setup?: Pick<
    PatternSetup,
    | 'breakoutHigh'
    | 'breakoutLow'
    | 'range'
    | 'tpLong'
    | 'tpShort'
    | 'candleUnixTime'
    | 'barDurationSec'
    | 'periodEnd'
  >;
}

export interface TradeMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  winRate: number;
  /** Annualized Sharpe (assuming ~288 5m periods/day) */
  sharpeRatio: number;
  /** Sum of estimated per-side fees (open + close) for all closed trades, USD */
  estimatedTotalFeesUsd: number;
  /** Fee events counted (2 per closed trade: entry + exit) */
  feeLegCount: number;
}
