import type { StrategyIntervalSec } from './candle-intervals';
import { intervalLabel } from './candle-intervals';

export interface StrategyTabDef {
  id: string;
  intervalSec: StrategyIntervalSec;
  label: string;
  /** Default: inside-bar SOL. BLK = IBIT paper BTC short + covers */
  kind?: 'inside' | 'blk';
}

export const TRADE_STRATEGIES: StrategyTabDef[] = [
  { id: 'tf5m', intervalSec: 300, label: '5m' },
  { id: 'tf10m', intervalSec: 600, label: '10m' },
  { id: 'tf60m', intervalSec: 3600, label: '60m' },
  { id: 'blk', intervalSec: 300, label: 'BLK', kind: 'blk' },
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
