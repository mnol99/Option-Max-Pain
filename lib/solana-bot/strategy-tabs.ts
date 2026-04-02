import type { StrategyIntervalSec } from './candle-intervals';
import { intervalLabel } from './candle-intervals';

/** Jupiter / Pyth mark asset for inside-bar candles and live ticks */
export type InsideBarUnderlying = 'sol' | 'btc' | 'eth';

export interface StrategyTabDef {
  id: string;
  intervalSec: StrategyIntervalSec;
  label: string;
  /** Default: inside-bar SOL. BLK = IBIT paper BTC short + covers */
  kind?: 'inside' | 'blk';
  /** OHLC + price source (default SOL for legacy ids) */
  underlying?: InsideBarUnderlying;
}

export const TRADE_STRATEGIES: StrategyTabDef[] = [
  { id: 'tf60m', intervalSec: 3600, label: '60m', underlying: 'sol' },
  { id: 'tf1d', intervalSec: 86400, label: 'Daily', underlying: 'sol' },
  { id: 'eth60m', intervalSec: 3600, label: 'ETH 60m', underlying: 'eth' },
  { id: 'eth1d', intervalSec: 86400, label: 'ETH Daily', underlying: 'eth' },
  { id: 'btc60m', intervalSec: 3600, label: 'BTC 60m', underlying: 'btc' },
  { id: 'btc1d', intervalSec: 86400, label: 'BTC Daily', underlying: 'btc' },
  { id: 'blk', intervalSec: 3600, label: 'BLK', kind: 'blk' },
];

/** Multi-timeframe inside-bar strategies only (excludes BLK). */
export const INSIDE_BAR_STRATEGIES: StrategyTabDef[] = TRADE_STRATEGIES.filter(
  (s) => s.kind !== 'blk'
);

export function strategyById(id: string): StrategyTabDef | undefined {
  return TRADE_STRATEGIES.find((s) => s.id === id);
}

export function defaultStrategyId(): string {
  return INSIDE_BAR_STRATEGIES[0]?.id ?? TRADE_STRATEGIES[0].id;
}

export function strategyUnderlying(s: StrategyTabDef): InsideBarUnderlying {
  return s.underlying ?? 'sol';
}
