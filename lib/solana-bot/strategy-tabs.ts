import type { StrategyIntervalSec } from './candle-intervals';
import { intervalLabel } from './candle-intervals';

export interface StrategyTabDef {
  id: string;
  intervalSec: StrategyIntervalSec;
  label: string;
}

export const TRADE_STRATEGIES: StrategyTabDef[] = [
  { id: 'tf5m', intervalSec: 300, label: '5m' },
  { id: 'tf10m', intervalSec: 600, label: '10m' },
  { id: 'tf60m', intervalSec: 3600, label: '60m' },
];

export function strategyById(id: string): StrategyTabDef | undefined {
  return TRADE_STRATEGIES.find((s) => s.id === id);
}

export function defaultStrategyId(): string {
  return TRADE_STRATEGIES[0].id;
}
