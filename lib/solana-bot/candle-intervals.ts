/** Supported OHLC bar lengths (seconds) for multi-strategy tabs */
export const STRATEGY_INTERVALS = [300, 600, 3600] as const;
export type StrategyIntervalSec = (typeof STRATEGY_INTERVALS)[number];

export function intervalLabel(sec: number): string {
  if (sec === 300) return '5m';
  if (sec === 600) return '10m';
  if (sec === 3600) return '60m';
  return `${sec}s`;
}

export function parseIntervalParam(v: string | null): StrategyIntervalSec {
  const n = parseInt(v ?? '300', 10);
  if (n === 300 || n === 600 || n === 3600) return n;
  return 300;
}
