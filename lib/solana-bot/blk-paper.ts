/**
 * BLK paper: IBIT signal → simulated short sized to on-chain BTC to Coinbase → 18 cover round-turns (10:00–12:50 ET).
 */

import { getBlkCoverScheduleUtc } from '@/lib/solana-bot/ibit-schedule';
import type { ClosedTrade } from '@/lib/solana-bot/types';
import { newTradeId } from '@/lib/solana-bot/trade-state';

export const BLK_STRATEGY_ID = 'blk';
export const BLK_DEFAULT_NOTIONAL_USD = 1000;
export const BLK_COVER_SLICES = 18;

export interface BlkPaperState {
  status: 'idle' | 'short_open';
  /** BTC price at entry (Pyth, when signal processed) */
  entryBtc: number | null;
  entryTime: number | null;
  /** Paper notional cap (USD); slice = this / 18 */
  notionalUsd: number;
  /** Main output to Coinbase Prime (BTC) — sizes the session short */
  chainMainOutBtc: number;
  /** Groups open leg + 18 covers in the trade log */
  sessionId: string | null;
  /** After first tick: session-open row already appended */
  sessionOpenEmitted: boolean;
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
    chainMainOutBtc: 0,
    sessionId: null,
    sessionOpenEmitted: false,
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
  notionalUsd: number,
  chainMainOutBtc: number
): BlkPaperState {
  const anchor = new Date(signalTimeSec * 1000);
  const coverScheduleUtc = getBlkCoverScheduleUtc(anchor).map((d) => d.toISOString());
  return {
    status: 'short_open',
    entryBtc: btcPrice,
    entryTime: signalTimeSec,
    notionalUsd,
    chainMainOutBtc,
    sessionId: newTradeId(),
    sessionOpenEmitted: false,
    coverScheduleUtc,
    nextSliceIndex: 0,
    signalTxid,
    cumulativePnlUsd: 0,
  };
}

export interface BlkProcessResult {
  state: BlkPaperState;
  closedTrades: ClosedTrade[];
}

function sessionOpenTrade(prev: BlkPaperState): ClosedTrade {
  const entry = prev.entryBtc!;
  const t = prev.entryTime!;
  const id = prev.sessionId!;
  return {
    id: newTradeId(),
    side: 'short',
    entryPrice: entry,
    entryTime: t,
    exitPrice: entry,
    exitTime: t,
    exitReason: 'blk_open',
    liquidationPrice: entry,
    pnl: 0,
    pnlPercent: 0,
    pnlUsd: 0,
    btcAmount: prev.chainMainOutBtc,
    asset: 'btc',
    ibitSignalTxid: prev.signalTxid ?? undefined,
    blkSessionId: id,
    chainMainOutBtc: prev.chainMainOutBtc,
  };
}

/**
 * On each price tick: emit session open once, then each due cover slice as its own round-turn (short + cover).
 */
export function processBlkPaperTick(
  prev: BlkPaperState,
  btcPrice: number,
  nowSec: number
): BlkProcessResult {
  if (prev.status !== 'short_open' || prev.entryBtc == null || prev.entryTime == null) {
    return { state: prev, closedTrades: [] };
  }

  const entry = prev.entryBtc;
  const sliceUsd = prev.notionalUsd / BLK_COVER_SLICES;
  const sliceBtc = sliceUsd / entry;
  const closedTrades: ClosedTrade[] = [];
  let next: BlkPaperState = { ...prev };
  let cumulative = prev.cumulativePnlUsd;

  if (!next.sessionOpenEmitted) {
    closedTrades.push(sessionOpenTrade(next));
    next = { ...next, sessionOpenEmitted: true };
  }

  while (
    next.nextSliceIndex < BLK_COVER_SLICES &&
    next.coverScheduleUtc[next.nextSliceIndex] != null
  ) {
    const slotUtc = Date.parse(next.coverScheduleUtc[next.nextSliceIndex]!);
    if (nowSec * 1000 < slotUtc) break;

    const legPnlUsd = ((entry - btcPrice) / entry) * sliceUsd;
    cumulative += legPnlUsd;
    const pnlPercent = (legPnlUsd / sliceUsd) * 100;
    const idx = next.nextSliceIndex;
    next.nextSliceIndex += 1;

    closedTrades.push({
      id: newTradeId(),
      side: 'short',
      entryPrice: entry,
      entryTime: next.entryTime!,
      exitPrice: btcPrice,
      exitTime: nowSec,
      exitReason: 'blk_cover',
      liquidationPrice: entry,
      pnl: legPnlUsd,
      pnlPercent,
      pnlUsd: legPnlUsd,
      btcAmount: sliceBtc,
      asset: 'btc',
      ibitSignalTxid: next.signalTxid ?? undefined,
      blkSessionId: next.sessionId ?? undefined,
      blkSliceIndex: idx,
    });
  }

  next.cumulativePnlUsd = cumulative;

  if (next.nextSliceIndex < BLK_COVER_SLICES) {
    return { state: next, closedTrades };
  }

  // All slices covered — reset session
  return {
    state: createBlkInitialState(),
    closedTrades,
  };
}
