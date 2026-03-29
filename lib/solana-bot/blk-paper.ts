/**
 * BLK paper: IBIT signal → simulated $1k BTC short → 18 covers 10:00–12:50 ET.
 */

import { getBlkCoverScheduleUtc } from '@/lib/solana-bot/ibit-schedule';
import type { ClosedTrade } from '@/lib/solana-bot/types';
import { newTradeId } from '@/lib/solana-bot/trade-state';

export const BLK_STRATEGY_ID = 'blk';
export const BLK_DEFAULT_NOTIONAL_USD = 1000;
export const BLK_COVER_SLICES = 18;

export interface BlkPaperState {
  status: 'idle' | 'short_open';
  /** BTC price at entry */
  entryBtc: number | null;
  entryTime: number | null;
  notionalUsd: number;
  /** ISO times for 18 covers (ET calendar day of signal) */
  coverScheduleUtc: string[];
  /** Next slice index 0..17 */
  nextSliceIndex: number;
  /** Signal txid for this session */
  signalTxid: string | null;
  /** Cumulative realized PnL (USD) from covers completed so far */
  cumulativePnlUsd: number;
}

export function createBlkInitialState(): BlkPaperState {
  return {
    status: 'idle',
    entryBtc: null,
    entryTime: null,
    notionalUsd: BLK_DEFAULT_NOTIONAL_USD,
    coverScheduleUtc: [],
    nextSliceIndex: 0,
    signalTxid: null,
    cumulativePnlUsd: 0,
  };
}

export function createBlkShortOpenState(
  btcPrice: number,
  signalTimeSec: number,
  signalTxid: string,
  notionalUsd: number
): BlkPaperState {
  const anchor = new Date(signalTimeSec * 1000);
  const coverScheduleUtc = getBlkCoverScheduleUtc(anchor).map((d) => d.toISOString());
  return {
    status: 'short_open',
    entryBtc: btcPrice,
    entryTime: signalTimeSec,
    notionalUsd,
    coverScheduleUtc,
    nextSliceIndex: 0,
    signalTxid,
    cumulativePnlUsd: 0,
  };
}

export interface BlkProcessResult {
  state: BlkPaperState;
  closedTrade: ClosedTrade | null;
}

/**
 * On each price tick: if cover time passed, realize one slice (short: gain when BTC drops).
 */
export function processBlkPaperTick(
  prev: BlkPaperState,
  btcPrice: number,
  nowSec: number
): BlkProcessResult {
  if (prev.status !== 'short_open' || prev.entryBtc == null || prev.entryTime == null) {
    return { state: prev, closedTrade: null };
  }

  const entry = prev.entryBtc;
  const sliceUsd = prev.notionalUsd / BLK_COVER_SLICES;
  let next = { ...prev };
  let cumulative = prev.cumulativePnlUsd;

  while (
    next.nextSliceIndex < BLK_COVER_SLICES &&
    next.coverScheduleUtc[next.nextSliceIndex] != null
  ) {
    const slotUtc = Date.parse(next.coverScheduleUtc[next.nextSliceIndex]!);
    if (nowSec * 1000 < slotUtc) break;

    // Short: PnL USD ≈ (entry - exit) / entry * slice notional
    const legPnlUsd = ((entry - btcPrice) / entry) * sliceUsd;
    cumulative += legPnlUsd;
    next.nextSliceIndex += 1;
  }

  next.cumulativePnlUsd = cumulative;

  if (next.nextSliceIndex < BLK_COVER_SLICES) {
    return { state: next, closedTrade: null };
  }

  // All slices covered — close session
  const totalPnlUsd = cumulative;
  const pnlPercent = (totalPnlUsd / prev.notionalUsd) * 100;
  const closed: ClosedTrade = {
    id: newTradeId(),
    side: 'short',
    entryPrice: entry,
    entryTime: prev.entryTime,
    exitPrice: btcPrice,
    exitTime: nowSec,
    exitReason: 'time',
    liquidationPrice: entry,
    pnl: totalPnlUsd,
    pnlPercent,
    pnlUsd: totalPnlUsd,
    btcAmount: prev.notionalUsd / entry,
    asset: 'btc',
    ibitSignalTxid: prev.signalTxid ?? undefined,
  };

  return {
    state: createBlkInitialState(),
    closedTrade: closed,
  };
}
