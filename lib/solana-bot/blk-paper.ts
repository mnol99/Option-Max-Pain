/**
 * BLK paper: IBIT signal → short sized to collateral × leverage (USD notional) → covers on schedule.
 * On-chain main output is recorded for audit only; position BTC = notionalUsd / entry price.
 */

import { getBlkCoverScheduleUtc, getEtDayKey } from '@/lib/solana-bot/ibit-schedule';
import type { ClosedTrade } from '@/lib/solana-bot/types';
import { newTradeId } from '@/lib/solana-bot/trade-state';

export const BLK_STRATEGY_ID = 'blk';
export const BLK_DEFAULT_NOTIONAL_USD = 1000;
/** Max slices (morning schedule); afternoon uses 6. */
export const BLK_COVER_SLICES = 18;

export interface BlkPaperState {
  status: 'idle' | 'short_open';
  /** ET day (YYYY-MM-DD) of the current/last session — blocks a second signal the same ET day */
  lastSessionEtDayKey: string | null;
  /** BTC price at entry (Pyth, when signal processed) */
  entryBtc: number | null;
  entryTime: number | null;
  /** Collateral USD for BLK (paper allocation slider) */
  collateralUsd: number;
  /** Leverage multiplier at entry */
  leverage: number;
  /** Notional USD = collateralUsd × leverage */
  notionalUsd: number;
  /** Main output to Coinbase (BTC) from chain — audit only */
  chainMainOutBtc: number;
  /** Simulated short size in BTC = notionalUsd / entryBtc */
  paperShortBtc: number;
  /** Covers this session (18 morning vs 6 afternoon) */
  coverSliceCount: number;
  /** Groups open leg + covers in the trade log */
  sessionId: string | null;
  /** After first tick: session-open row already appended */
  sessionOpenEmitted: boolean;
  /** ISO times for cover slots (ET calendar day of signal) */
  coverScheduleUtc: string[];
  /** Next slice index */
  nextSliceIndex: number;
  /** Signal txid for this session */
  signalTxid: string | null;
  /** Bitcoin input addresses that funded the transfer (from chain) */
  ibitInputSourceAddresses: string[];
  /** Largest prevout address (typical feeder) */
  ibitPrimarySourceAddress: string | null;
  /** Any input was on the optional legacy custodian watch list */
  ibitWatchListMatch: boolean;
  /** coinbase_deposit | source_watch | extra_txid | arkham */
  ibitSignalSource: string | null;
  /** When source is arkham: GET /transfers `base` entity */
  ibitArkhamEntityBase: string | null;
  /** Cumulative realized PnL (USD) from covers completed so far */
  cumulativePnlUsd: number;
}

export function createBlkInitialState(overrides?: Partial<Pick<BlkPaperState, 'lastSessionEtDayKey'>>): BlkPaperState {
  const lev = 1.5;
  const col = BLK_DEFAULT_NOTIONAL_USD;
  return {
    status: 'idle',
    lastSessionEtDayKey: overrides?.lastSessionEtDayKey ?? null,
    entryBtc: null,
    entryTime: null,
    collateralUsd: col,
    leverage: lev,
    notionalUsd: col * lev,
    chainMainOutBtc: 0,
    paperShortBtc: 0,
    coverSliceCount: 0,
    sessionId: null,
    sessionOpenEmitted: false,
    coverScheduleUtc: [],
    nextSliceIndex: 0,
    signalTxid: null,
    ibitInputSourceAddresses: [],
    ibitPrimarySourceAddress: null,
    ibitWatchListMatch: false,
    ibitSignalSource: null,
    ibitArkhamEntityBase: null,
    cumulativePnlUsd: 0,
  };
}

export function createBlkShortOpenState(
  btcPrice: number,
  signalTimeSec: number,
  signalTxid: string,
  collateralUsd: number,
  leverage: number,
  chainMainOutBtc: number,
  ibitMeta?: {
    inputSourceAddresses: string[];
    primarySourceAddress: string | null;
    watchListMatch: boolean;
    signalSource: string;
    arkhamEntityBase?: string;
  }
): BlkPaperState {
  const anchor = new Date(signalTimeSec * 1000);
  const notionalUsd = collateralUsd * leverage;
  const dayKey = getEtDayKey(anchor);
  const coverScheduleUtc = getBlkCoverScheduleUtc(anchor).map((d) => d.toISOString());
  const coverSliceCount = coverScheduleUtc.length;
  const paperShortBtc = notionalUsd / btcPrice;
  return {
    status: 'short_open',
    lastSessionEtDayKey: dayKey,
    entryBtc: btcPrice,
    entryTime: signalTimeSec,
    collateralUsd,
    leverage,
    notionalUsd,
    chainMainOutBtc,
    paperShortBtc,
    coverSliceCount,
    sessionId: newTradeId(),
    sessionOpenEmitted: false,
    coverScheduleUtc,
    nextSliceIndex: 0,
    signalTxid,
    ibitInputSourceAddresses: ibitMeta?.inputSourceAddresses ?? [],
    ibitPrimarySourceAddress: ibitMeta?.primarySourceAddress ?? null,
    ibitWatchListMatch: ibitMeta?.watchListMatch ?? false,
    ibitSignalSource: ibitMeta?.signalSource ?? null,
    ibitArkhamEntityBase:
      ibitMeta?.signalSource === 'arkham' && ibitMeta?.arkhamEntityBase
        ? ibitMeta.arkhamEntityBase
        : null,
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
    btcAmount: prev.paperShortBtc,
    asset: 'btc',
    ibitSignalTxid: prev.signalTxid ?? undefined,
    blkSessionId: id,
    chainMainOutBtc: prev.chainMainOutBtc,
    blkCoverSliceTotal: prev.coverSliceCount,
    ibitInputSourceAddresses:
      prev.ibitInputSourceAddresses.length > 0 ? [...prev.ibitInputSourceAddresses] : undefined,
    ibitPrimarySourceAddress: prev.ibitPrimarySourceAddress ?? undefined,
    ibitWatchListMatch: prev.ibitWatchListMatch || undefined,
    ibitSignalSource: prev.ibitSignalSource ?? undefined,
    ibitArkhamEntityBase:
      prev.ibitSignalSource === 'arkham' && prev.ibitArkhamEntityBase
        ? prev.ibitArkhamEntityBase
        : undefined,
  };
}

/**
 * One tick: emit session open once, then at most **one** cover whose slot has passed (distinct time/price per slice).
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
  const n = Math.max(1, prev.coverSliceCount || prev.coverScheduleUtc.length);
  const sliceBtc = prev.paperShortBtc / n;
  const sliceUsd = sliceBtc * entry;
  const closedTrades: ClosedTrade[] = [];
  let next: BlkPaperState = { ...prev };
  let cumulative = prev.cumulativePnlUsd;

  if (!next.sessionOpenEmitted) {
    closedTrades.push(sessionOpenTrade(next));
    next = { ...next, sessionOpenEmitted: true };
    return { state: next, closedTrades };
  }

  if (next.nextSliceIndex >= n) {
    return { state: next, closedTrades: [] };
  }

  const slotIso = next.coverScheduleUtc[next.nextSliceIndex];
  if (slotIso == null) {
    return { state: next, closedTrades: [] };
  }

  const slotEndMs = Date.parse(slotIso);
  if (nowSec * 1000 < slotEndMs) {
    return { state: next, closedTrades: [] };
  }

  const legPnlUsd = (entry - btcPrice) * sliceBtc;
  cumulative += legPnlUsd;
  const pnlPercent = sliceUsd > 0 ? (legPnlUsd / sliceUsd) * 100 : 0;
  const idx = next.nextSliceIndex;
  const coverExitTimeSec = Math.floor(slotEndMs / 1000);

  next.nextSliceIndex += 1;
  next.cumulativePnlUsd = cumulative;

  closedTrades.push({
    id: newTradeId(),
    side: 'short',
    entryPrice: entry,
    entryTime: next.entryTime!,
    exitPrice: btcPrice,
    exitTime: coverExitTimeSec,
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
    blkCoverSliceTotal: n,
    ibitInputSourceAddresses:
      next.ibitInputSourceAddresses.length > 0 ? [...next.ibitInputSourceAddresses] : undefined,
    ibitPrimarySourceAddress: next.ibitPrimarySourceAddress ?? undefined,
    ibitWatchListMatch: next.ibitWatchListMatch || undefined,
    ibitSignalSource: next.ibitSignalSource ?? undefined,
    ibitArkhamEntityBase:
      next.ibitSignalSource === 'arkham' && next.ibitArkhamEntityBase
        ? next.ibitArkhamEntityBase
        : undefined,
  });

  if (next.nextSliceIndex >= n) {
    return {
      state: createBlkInitialState({ lastSessionEtDayKey: prev.lastSessionEtDayKey }),
      closedTrades,
    };
  }

  return { state: next, closedTrades };
}
