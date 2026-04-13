'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { VersionedTransaction } from '@solana/web3.js';
import { detectPattern, isBreakoutLong, isBreakoutShort } from '@/lib/solana-bot/pattern-engine';
import { applyInsideBarPatternFromCandles } from '@/lib/solana-bot/inside-bar-engine';
import {
  createInitialState,
  enterLong,
  enterShort,
  checkPositionExit,
  checkReversedExit,
  computeMetrics,
  computeBlkMetrics,
  getEffectiveTpLong,
  getEffectiveTpShort,
  JUPITER_PERPS_EST_FEE_BPS_PER_SIDE,
  timeWindowSecFromSetup,
  POSITION_MANAGEMENT_SEC,
  managementWindowEndFromClosedTradeSetup,
} from '@/lib/solana-bot/trade-state';
import type { TradeState, ClosedTrade, OHLCVCandle } from '@/lib/solana-bot/types';
import {
  TRADE_STRATEGIES,
  INSIDE_BAR_STRATEGIES,
  defaultStrategyId,
  strategyUnderlying,
} from '@/lib/solana-bot/strategy-tabs';
import type { InsideBarUnderlying } from '@/lib/solana-bot/strategy-tabs';
import { intervalLabel } from '@/lib/solana-bot/candle-intervals';
import {
  BLK_STRATEGY_ID,
  BLK_COVER_SLICES,
  BLK_DEFAULT_NOTIONAL_USD,
  createBlkInitialState,
  createBlkLongOpenState,
  createBlkShortOpenState,
  processBlkPaperTick,
  type BlkPaperState,
} from '@/lib/solana-bot/blk-paper';
import type { InsideBarServerSnapshot } from '@/lib/solana-bot/inside-bar-server-state';
import { parseApiJson } from '@/lib/solana-bot/parse-api-json';
import {
  isWeekendHalt60mEt,
  BLK_COVER_SLOT_COUNT_MORNING,
  BLK_COVER_SLOT_COUNT_AFTERNOON,
  BLK_LONG_COVER_SLOT_COUNT,
  getEtDayKey,
} from '@/lib/solana-bot/ibit-schedule';

const PRICE_POLL_MS = 1000;   // When pattern detected or in position
const OHLCV_POLL_MS = 60000;  // Check for new candles every minute
const PRICE_POLL_IDLE_MS = 10000; // When idle, poll less often
const INSIDE_BAR_SERVER_SYNC_MS = (() => {
  if (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_INSIDE_BAR_SYNC_MS) {
    const n = Number(process.env.NEXT_PUBLIC_INSIDE_BAR_SYNC_MS);
    if (Number.isFinite(n) && n >= 500) return n;
  }
  return 2000;
})();

/** Survive navigate away + back (e.g. /mean-reversion) in the same tab */
const TRADE_SESSION_STORAGE_KEY = 'solana-bot-trade-session-v6';
/** Survives tab refresh (unlike sessionStorage) — dedupe IBIT txids for BLK */
const BLK_PROCESSED_TXIDS_KEY = 'solana-bot-blk-processed-txids-v1';
/** ET days that already opened a BLK short / long (separate keys for same-day short + long) */
const BLK_TRADED_SHORT_DAYS_KEY = 'solana-bot-blk-traded-short-et-days-v1';
const BLK_TRADED_LONG_DAYS_KEY = 'solana-bot-blk-traded-long-et-days-v1';
const MAX_BLK_TXID_CACHE = 500;

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Daily bars are ~24h ET each; raw "minutes" looks like a bug (e.g. 4974). */
function formatWarmupEstimate(intervalSec: number, warmupMinutes: number): string {
  if (intervalSec !== 86400) {
    return `~${warmupMinutes} min`;
  }
  const d = Math.floor(warmupMinutes / (24 * 60));
  const h = Math.ceil((warmupMinutes % (24 * 60)) / 60);
  if (d > 0 && h > 0) return `~${d} day${d === 1 ? '' : 's'} ${h} hr`;
  if (d > 0) return `~${d} day${d === 1 ? '' : 's'}`;
  return `~${warmupMinutes} min`;
}

function formatPrice(n: number): string {
  return n.toFixed(2);
}

/** Human-readable duration from entry to exit (for audit). */
function formatHoldDuration(entryTime: number, exitTime: number): string {
  const sec = Math.max(0, exitTime - entryTime);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

function timeWindowSecFromClosedTrade(t: ClosedTrade): number {
  const bar = t.setup?.barDurationSec;
  if (bar != null && bar > 0) return bar * 2;
  return POSITION_MANAGEMENT_SEC;
}

function tradeManagementWindowEndUnix(t: ClosedTrade): number {
  return (
    managementWindowEndFromClosedTradeSetup(t.setup) ??
    t.entryTime + timeWindowSecFromClosedTrade(t)
  );
}

function emptyTradesMap(): Record<string, ClosedTrade[]> {
  return Object.fromEntries(TRADE_STRATEGIES.map((s) => [s.id, [] as ClosedTrade[]]));
}

function initialInsideStateMap(): Record<string, TradeState> {
  return Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, createInitialState()]));
}

export default function TradePage() {
  const { publicKey, connected, wallet } = useWallet();
  const { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  const [activeStrategyId, setActiveStrategyId] = useState(defaultStrategyId);
  const [auditExpanded, setAuditExpanded] = useState<Set<string>>(new Set());
  const [breakoutByStrategy, setBreakoutByStrategy] = useState<
    Record<string, { long: number; short: number }>
  >(() =>
    Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, { long: 0, short: 0 }]))
  );
  const [stateByStrategy, setStateByStrategy] = useState<Record<string, TradeState>>(
    initialInsideStateMap
  );
  const [price, setPrice] = useState<number | null>(null);
  const [priceTime, setPriceTime] = useState<number | null>(null);
  /** Live marks per underlying (SOL Doves/Pyth, BTC/ETH Pyth) — each strategy reads its underlying */
  const [markPrices, setMarkPrices] = useState<
    Partial<Record<InsideBarUnderlying, { price: number; time: number }>>
  >({});
  const [candlesByStrategy, setCandlesByStrategy] = useState<Record<string, OHLCVCandle[]>>(
    () => Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, []]))
  );
  const [tradesByStrategy, setTradesByStrategy] = useState<Record<string, ClosedTrade[]>>(
    emptyTradesMap
  );
  const [warmupByStrategy, setWarmupByStrategy] = useState<Record<string, number>>(
    () => Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, 0]))
  );
  const [error, setError] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [paperStartingBalance, setPaperStartingBalance] = useState(3000);
  const [paperPositionSizeUsd, setPaperPositionSizeUsd] = useState(1000);
  const [liveAmountToRun, setLiveAmountToRun] = useState(1000);
  const [leverage, setLeverage] = useState(1.5);
  const [useChartPrice, setUseChartPrice] = useState(false);
  const liveAmountByStrategyRef = useRef<Record<string, number>>(
    Object.fromEntries(TRADE_STRATEGIES.map((s) => [s.id, 1000]))
  );
  const enteringRef = useRef<Record<string, boolean>>(
    Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, false]))
  );
  /** Skip one client price tick after switching paper→live (avoid duplicate with server). */
  const paperSyncSkipRef = useRef(false);
  const tradesInsideBarRef = useRef<Record<string, ClosedTrade[]>>(
    Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, [] as ClosedTrade[]]))
  );
  const stateByStrategyRef = useRef(stateByStrategy);
  const breakoutRef = useRef<Record<string, { long: number; short: number }>>(
    Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, { long: 0, short: 0 }]))
  );

  const [blkPaperState, setBlkPaperState] = useState<BlkPaperState>(createBlkInitialState);
  const blkPaperStateRef = useRef(blkPaperState);
  blkPaperStateRef.current = blkPaperState;
  const blkProcessedSignalsRef = useRef<Set<string>>(new Set());
  const blkTradedShortEtDaysRef = useRef<Set<string>>(new Set());
  const blkTradedLongEtDaysRef = useRef<Set<string>>(new Set());

  const clearBlkPaperHistory = useCallback(() => {
    const fresh = createBlkInitialState();
    blkPaperStateRef.current = fresh;
    setBlkPaperState(fresh);
    blkProcessedSignalsRef.current = new Set();
    blkTradedShortEtDaysRef.current = new Set();
    blkTradedLongEtDaysRef.current = new Set();
    if (typeof window !== 'undefined') {
      try {
        localStorage.removeItem(BLK_PROCESSED_TXIDS_KEY);
        localStorage.removeItem(BLK_TRADED_SHORT_DAYS_KEY);
        localStorage.removeItem(BLK_TRADED_LONG_DAYS_KEY);
      } catch {
        /* ignore */
      }
      void fetch('/api/solana-bot/blk/processed-txids', { method: 'DELETE' }).catch(() => {
        /* ignore */
      });
    }
    setTradesByStrategy((p) => ({ ...p, [BLK_STRATEGY_ID]: [] }));
    setAuditExpanded(new Set());
  }, []);

  /** Keep idle BLK paper sizing in sync with allocation × leverage (no mid-session resize). */
  useEffect(() => {
    if (liveMode) return;
    setBlkPaperState((prev) => {
      if (prev.status !== 'idle') return prev;
      const col = paperPositionSizeUsd;
      const lev = leverage;
      if (
        prev.collateralUsd === col &&
        prev.leverage === lev &&
        Math.abs(prev.notionalUsd - col * lev) < 1e-6
      ) {
        return prev;
      }
      return {
        ...prev,
        collateralUsd: col,
        leverage: lev,
        notionalUsd: col * lev,
      };
    });
  }, [paperPositionSizeUsd, leverage, liveMode]);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [btcTime, setBtcTime] = useState<number | null>(null);

  useEffect(() => {
    stateByStrategyRef.current = stateByStrategy;
  }, [stateByStrategy]);

  useEffect(() => {
    for (const s of INSIDE_BAR_STRATEGIES) {
      tradesInsideBarRef.current[s.id] = tradesByStrategy[s.id] ?? [];
    }
  }, [tradesByStrategy]);

  const [sessionHydrated, setSessionHydrated] = useState(false);

  const persistBlkProcessedTxids = useCallback(() => {
    if (typeof window === 'undefined') return;
    try {
      const arr = Array.from(blkProcessedSignalsRef.current).slice(-MAX_BLK_TXID_CACHE);
      localStorage.setItem(BLK_PROCESSED_TXIDS_KEY, JSON.stringify(arr));
      localStorage.setItem(
        BLK_TRADED_SHORT_DAYS_KEY,
        JSON.stringify(Array.from(blkTradedShortEtDaysRef.current))
      );
      localStorage.setItem(
        BLK_TRADED_LONG_DAYS_KEY,
        JSON.stringify(Array.from(blkTradedLongEtDaysRef.current))
      );
    } catch {
      /* quota / private mode */
    }
    void fetch('/api/solana-bot/blk/processed-txids', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        txids: Array.from(blkProcessedSignalsRef.current),
        tradedShortEtDayKeys: Array.from(blkTradedShortEtDaysRef.current),
        tradedLongEtDayKeys: Array.from(blkTradedLongEtDaysRef.current),
      }),
    }).catch(() => {
      /* server dedupe optional */
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = sessionStorage.getItem(TRADE_SESSION_STORAGE_KEY);
      if (!raw) {
        setSessionHydrated(true);
        return;
      }
      const p = JSON.parse(raw) as {
        activeStrategyId?: string;
        stateByStrategy?: Record<string, TradeState>;
        tradesByStrategy?: Record<string, ClosedTrade[]>;
        breakoutByStrategy?: Record<string, { long: number; short: number }>;
        entering?: Record<string, boolean>;
        paperStartingBalance?: number;
        paperPositionSizeUsd?: number;
        liveAmountToRun?: number;
        leverage?: number;
        useChartPrice?: boolean;
        liveMode?: boolean;
        blkPaperState?: BlkPaperState;
        /** Legacy v6: long session was split into a second object — merged into blkPaperState on load */
        blkLongPaperState?: BlkPaperState;
        blkProcessedSignals?: string[];
      };
      if (p.activeStrategyId && TRADE_STRATEGIES.some((s) => s.id === p.activeStrategyId)) {
        setActiveStrategyId(p.activeStrategyId);
      }
      if (p.stateByStrategy) {
        setStateByStrategy(p.stateByStrategy);
        stateByStrategyRef.current = p.stateByStrategy;
      }
      if (p.tradesByStrategy) setTradesByStrategy(p.tradesByStrategy);
      if (p.breakoutByStrategy) {
        setBreakoutByStrategy(p.breakoutByStrategy);
        for (const s of INSIDE_BAR_STRATEGIES) {
          const b = p.breakoutByStrategy[s.id];
          if (b) breakoutRef.current[s.id] = { ...b };
        }
      }
      if (p.paperStartingBalance != null) setPaperStartingBalance(p.paperStartingBalance);
      if (p.paperPositionSizeUsd != null) setPaperPositionSizeUsd(p.paperPositionSizeUsd);
      if (p.liveAmountToRun != null) setLiveAmountToRun(p.liveAmountToRun);
      if (p.leverage != null) setLeverage(p.leverage);
      if (p.useChartPrice != null) setUseChartPrice(p.useChartPrice);
      if (p.liveMode != null) setLiveMode(p.liveMode);
        if (p.blkPaperState) {
        const bs = p.blkPaperState as BlkPaperState & {
          lastSessionEtDayKey?: string | null;
          lastShortEtDayKey?: string | null;
          lastLongEtDayKey?: string | null;
          ibitInputSourceAddresses?: string[];
          ibitPrimarySourceAddress?: string | null;
          ibitWatchListMatch?: boolean;
          ibitSignalSource?: string | null;
          ibitArkhamEntityBase?: string | null;
        };
        if (bs.coverSliceCount == null && bs.coverScheduleUtc?.length) {
          bs.coverSliceCount = bs.coverScheduleUtc.length;
        }
        const legacyDay = bs.lastSessionEtDayKey;
        if (bs.lastShortEtDayKey === undefined) bs.lastShortEtDayKey = null;
        if (bs.lastLongEtDayKey === undefined) bs.lastLongEtDayKey = null;
        if (legacyDay && !bs.lastShortEtDayKey && !bs.lastLongEtDayKey) {
          if (bs.status === 'short_open') bs.lastShortEtDayKey = legacyDay;
          if (bs.status === 'long_open') bs.lastLongEtDayKey = legacyDay;
        }
        if (
          bs.status === 'short_open' &&
          bs.lastShortEtDayKey == null &&
          bs.entryTime != null
        ) {
          bs.lastShortEtDayKey = getEtDayKey(new Date(bs.entryTime * 1000));
        }
        if (
          bs.status === 'long_open' &&
          bs.lastLongEtDayKey == null &&
          bs.entryTime != null
        ) {
          bs.lastLongEtDayKey = getEtDayKey(new Date(bs.entryTime * 1000));
        }
        const levHydr = p.leverage ?? 1.5;
        const colHydr = p.paperPositionSizeUsd ?? 1000;
        if (bs.ibitInputSourceAddresses == null) bs.ibitInputSourceAddresses = [];
        if (bs.ibitPrimarySourceAddress === undefined) bs.ibitPrimarySourceAddress = null;
        if (bs.ibitWatchListMatch == null) bs.ibitWatchListMatch = false;
        if (bs.ibitSignalSource === undefined) bs.ibitSignalSource = null;
        if (bs.ibitArkhamEntityBase === undefined) bs.ibitArkhamEntityBase = null;
        if (bs.collateralUsd == null || bs.leverage == null) {
          if (bs.status === 'short_open' || bs.status === 'long_open') {
            bs.leverage = bs.leverage ?? 1;
            bs.collateralUsd = bs.notionalUsd ?? colHydr;
            bs.notionalUsd = bs.collateralUsd * bs.leverage;
          } else {
            bs.leverage = bs.leverage ?? levHydr;
            bs.collateralUsd = colHydr;
            bs.notionalUsd = bs.collateralUsd * bs.leverage;
          }
        }
        setBlkPaperState(bs as BlkPaperState);
        if (bs.lastShortEtDayKey) blkTradedShortEtDaysRef.current.add(bs.lastShortEtDayKey);
        if (bs.lastLongEtDayKey) blkTradedLongEtDaysRef.current.add(bs.lastLongEtDayKey);
      }
      if (p.blkLongPaperState) {
        const bl = p.blkLongPaperState as BlkPaperState & {
          lastSessionEtDayKey?: string | null;
        };
        if (bl.coverSliceCount == null && bl.coverScheduleUtc?.length) {
          bl.coverSliceCount = bl.coverScheduleUtc.length;
        }
        if (bl.lastShortEtDayKey === undefined) bl.lastShortEtDayKey = null;
        if (bl.lastLongEtDayKey === undefined) bl.lastLongEtDayKey = null;
        const leg = bl.lastSessionEtDayKey;
        if (leg && !bl.lastShortEtDayKey && !bl.lastLongEtDayKey) {
          if (bl.status === 'short_open') bl.lastShortEtDayKey = leg;
          if (bl.status === 'long_open') bl.lastLongEtDayKey = leg;
        }
        if (
          bl.status === 'short_open' &&
          bl.lastShortEtDayKey == null &&
          bl.entryTime != null
        ) {
          bl.lastShortEtDayKey = getEtDayKey(new Date(bl.entryTime * 1000));
        }
        if (bl.status === 'long_open' && bl.lastLongEtDayKey == null && bl.entryTime != null) {
          bl.lastLongEtDayKey = getEtDayKey(new Date(bl.entryTime * 1000));
        }
        const shortOk = bl.status === 'short_open' || bl.status === 'long_open';
        const prevHydr = p.blkPaperState as BlkPaperState | undefined;
        const prevIdle = !prevHydr || prevHydr.status === 'idle';
        if (shortOk && prevIdle) {
          setBlkPaperState(bl as BlkPaperState);
          blkPaperStateRef.current = bl as BlkPaperState;
          if (bl.lastShortEtDayKey) blkTradedShortEtDaysRef.current.add(bl.lastShortEtDayKey);
          if (bl.lastLongEtDayKey) blkTradedLongEtDaysRef.current.add(bl.lastLongEtDayKey);
        }
      }
      if (p.entering) {
        for (const s of INSIDE_BAR_STRATEGIES) {
          enteringRef.current[s.id] = p.entering[s.id] ?? false;
        }
      }
      if (p.blkProcessedSignals?.length) {
        blkProcessedSignalsRef.current = new Set(p.blkProcessedSignals);
      }
      try {
        const blkRaw = localStorage.getItem(BLK_PROCESSED_TXIDS_KEY);
        if (blkRaw) {
          const parsed = JSON.parse(blkRaw) as string[];
          if (Array.isArray(parsed)) {
            const merged = new Set([
              ...Array.from(blkProcessedSignalsRef.current),
              ...parsed,
            ]);
            blkProcessedSignalsRef.current = merged;
          }
        }
        const shortDaysRaw = localStorage.getItem(BLK_TRADED_SHORT_DAYS_KEY);
        if (shortDaysRaw) {
          const parsed = JSON.parse(shortDaysRaw) as string[];
          if (Array.isArray(parsed)) {
            for (const d of parsed) {
              if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
                blkTradedShortEtDaysRef.current.add(d);
              }
            }
          }
        }
        const longDaysRaw = localStorage.getItem(BLK_TRADED_LONG_DAYS_KEY);
        if (longDaysRaw) {
          const parsed = JSON.parse(longDaysRaw) as string[];
          if (Array.isArray(parsed)) {
            for (const d of parsed) {
              if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
                blkTradedLongEtDaysRef.current.add(d);
              }
            }
          }
        }
        const legacyDays = localStorage.getItem('solana-bot-blk-traded-et-days-v1');
        if (legacyDays) {
          try {
            const parsed = JSON.parse(legacyDays) as string[];
            for (const d of parsed) {
              if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
                blkTradedShortEtDaysRef.current.add(d);
                blkTradedLongEtDaysRef.current.add(d);
              }
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore corrupt storage */
    }
    setSessionHydrated(true);
  }, []);

  useEffect(() => {
    if (!sessionHydrated) return;
    persistBlkProcessedTxids();
  }, [sessionHydrated, persistBlkProcessedTxids]);

  /** Re-register IBIT txids + ET day keys from BLK trade log so server dedupe stays aligned after refresh. */
  useEffect(() => {
    if (!sessionHydrated) return;
    const list = tradesByStrategy[BLK_STRATEGY_ID] ?? [];
    let changed = false;
    for (const t of list) {
      const x = t.ibitSignalTxid;
      if (x && !blkProcessedSignalsRef.current.has(x)) {
        blkProcessedSignalsRef.current.add(x);
        changed = true;
      }
      if (t.entryTime != null && t.ibitSignalTxid) {
        const dk = getEtDayKey(new Date(t.entryTime * 1000));
        if (t.side === 'long') {
          if (!blkTradedLongEtDaysRef.current.has(dk)) {
            blkTradedLongEtDaysRef.current.add(dk);
            changed = true;
          }
        } else {
          if (!blkTradedShortEtDaysRef.current.has(dk)) {
            blkTradedShortEtDaysRef.current.add(dk);
            changed = true;
          }
        }
      }
    }
    if (changed) persistBlkProcessedTxids();
  }, [sessionHydrated, tradesByStrategy, persistBlkProcessedTxids]);

  useEffect(() => {
    if (!sessionHydrated || typeof window === 'undefined') return;
    try {
      const payload = {
        activeStrategyId,
        stateByStrategy,
        tradesByStrategy,
        breakoutByStrategy: Object.fromEntries(
          INSIDE_BAR_STRATEGIES.map((s) => [s.id, { ...breakoutRef.current[s.id] }])
        ),
        entering: Object.fromEntries(
          INSIDE_BAR_STRATEGIES.map((s) => [s.id, enteringRef.current[s.id] ?? false])
        ),
        paperStartingBalance,
        paperPositionSizeUsd,
        liveAmountToRun,
        leverage,
        useChartPrice,
        liveMode,
        blkPaperState,
        blkProcessedSignals: Array.from(blkProcessedSignalsRef.current),
      };
      sessionStorage.setItem(TRADE_SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota / private mode */
    }
  }, [
    sessionHydrated,
    activeStrategyId,
    stateByStrategy,
    tradesByStrategy,
    breakoutByStrategy,
    paperStartingBalance,
    paperPositionSizeUsd,
    liveAmountToRun,
    leverage,
    useChartPrice,
    liveMode,
    blkPaperState,
  ]);

  const activeDef = TRADE_STRATEGIES.find((s) => s.id === activeStrategyId) ?? TRADE_STRATEGIES[0];
  const activeIntervalSec = activeDef.intervalSec;
  /** Use id + kind so BLK never shows 5m/60m trades if `kind` is missing on old bundles */
  const isBlkTab = activeStrategyId === BLK_STRATEGY_ID || activeDef.kind === 'blk';
  const activeUnderlying: InsideBarUnderlying = isBlkTab ? 'sol' : strategyUnderlying(activeDef);
  const assetLabel =
    activeUnderlying === 'sol' ? 'SOL' : activeUnderlying === 'btc' ? 'WBTC' : 'ETH';
  const liveMark = markPrices[activeUnderlying];
  const state = stateByStrategy[activeStrategyId] ?? createInitialState();
  const candles = isBlkTab ? [] : (candlesByStrategy[activeStrategyId] ?? []);
  const trades = isBlkTab
    ? (tradesByStrategy[BLK_STRATEGY_ID] ?? [])
    : (tradesByStrategy[activeStrategyId] ?? []);
  const warmupMinutes = isBlkTab ? 0 : (warmupByStrategy[activeStrategyId] ?? 0);
  const breakoutConfirmCount = breakoutByStrategy[activeStrategyId] ?? { long: 0, short: 0 };

  const executeOnBreakout = useCallback(
    async (side: 'long' | 'short', markPrice: number, strategyId: string) => {
      if (!publicKey || !wallet?.adapter) return;
      setExecError(null);
      const sizeUsd = liveAmountByStrategyRef.current[strategyId] ?? liveAmountToRun;
      const def = INSIDE_BAR_STRATEGIES.find((x) => x.id === strategyId);
      const asset = def ? strategyUnderlying(def) : 'sol';
      try {
        const res = await fetch('/api/solana-bot/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side,
          owner: publicKey.toString(),
          sizeUsd,
          leverage,
          solPrice: asset === 'sol' ? markPrice : undefined,
          btcPrice: asset === 'btc' ? markPrice : undefined,
          asset: asset === 'btc' ? 'btc' : 'sol',
        }),
        });
        const json = await parseApiJson<{ success?: boolean; error?: string; data?: { serializedTx?: string } }>(
          res
        );
        if (!json.success) {
          setExecError(json.error || 'Execution failed');
          return;
        }
        if (json.data?.serializedTx) {
          const tx = VersionedTransaction.deserialize(
            Buffer.from(json.data.serializedTx, 'base64')
          );
          const sig = await wallet.adapter.sendTransaction(tx, connection, {
            skipPreflight: false,
          });
          await connection.confirmTransaction(sig);
        }
      } catch (e) {
        setExecError(e instanceof Error ? e.message : 'Execution failed');
      }
    },
    [publicKey, wallet, connection, liveAmountToRun, leverage]
  );

  useEffect(() => {
    for (const s of TRADE_STRATEGIES) {
      liveAmountByStrategyRef.current[s.id] = liveAmountToRun;
    }
    liveAmountByStrategyRef.current[BLK_STRATEGY_ID] = liveMode
      ? liveAmountToRun
      : paperPositionSizeUsd;
  }, [liveAmountToRun, liveMode, paperPositionSizeUsd]);

  const fetchBtcPrice = useCallback(async () => {
    try {
      const res = await fetch('/api/solana-bot/price?asset=btc');
      const json = await parseApiJson<{ success?: boolean; data?: { price?: number; timestamp?: number } }>(
        res
      );
      if (json.success && json.data?.price != null) {
        setBtcPrice(json.data.price);
        setBtcTime(json.data.timestamp ?? Math.floor(Date.now() / 1000));
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchBtcPrice();
    const id = setInterval(fetchBtcPrice, 2000);
    return () => clearInterval(id);
  }, [fetchBtcPrice]);

  /** IBIT poll → paper short/long (allocation × leverage) when signal; no poll while a BLK session is open. */
  useEffect(() => {
    if (liveMode || btcPrice == null || btcPrice <= 0) return;
    let cancelled = false;
    const run = async () => {
      try {
        const snap = blkPaperStateRef.current;
        if (snap.status !== 'idle') return;

        const res = await fetch('/api/solana-bot/ibit/poll');
        const json = await parseApiJson<{
          success?: boolean;
          data?: {
            signals?: Array<{
              txid: string;
              blockTime: number;
              mainOutBtc: number;
              sourceAddress?: string;
              inputSourceAddresses?: string[];
              watchListMatch?: boolean;
              signalSource?: string;
              arkhamEntityBase?: string;
              blkArkhamBatchRole?: 'second_out_short' | 'second_in_long' | 'second_striker_in_long';
            }>;
          };
        }>(res);
        if (!json.success || !json.data?.signals || cancelled) return;
        const signals = json.data.signals as Array<{
          txid: string;
          blockTime: number;
          mainOutBtc: number;
          sourceAddress?: string;
          inputSourceAddresses?: string[];
          watchListMatch?: boolean;
          signalSource?: string;
          arkhamEntityBase?: string;
          blkArkhamBatchRole?: 'second_out_short' | 'second_in_long' | 'second_striker_in_long';
        }>;
        const price = btcPrice;
        setBlkPaperState((prev) => {
          if (prev.status !== 'idle') return prev;
          for (const sig of signals) {
            if (blkProcessedSignalsRef.current.has(sig.txid)) continue;
            const t = sig.blockTime > 0 ? sig.blockTime : Math.floor(Date.now() / 1000);
            const signalDayKey = getEtDayKey(new Date(t * 1000));
            const role = sig.blkArkhamBatchRole;
            const isLongSignal = role === 'second_in_long' || role === 'second_striker_in_long';
            const isShortSignal = role === 'second_out_short' || role == null;
            if (isLongSignal) {
              if (blkTradedLongEtDaysRef.current.has(signalDayKey)) continue;
            } else if (isShortSignal) {
              if (blkTradedShortEtDaysRef.current.has(signalDayKey)) continue;
            } else {
              continue;
            }
            blkProcessedSignalsRef.current.add(sig.txid);
            if (isLongSignal) {
              blkTradedLongEtDaysRef.current.add(signalDayKey);
            } else {
              blkTradedShortEtDaysRef.current.add(signalDayKey);
            }
            const chainBtc =
              typeof sig.mainOutBtc === 'number' && sig.mainOutBtc > 0
                ? sig.mainOutBtc
                : prev.collateralUsd / price;
            const inputs = sig.inputSourceAddresses ?? [];
            const primary = sig.sourceAddress ?? inputs[0] ?? null;
            const meta = {
              inputSourceAddresses: inputs,
              primarySourceAddress: primary,
              watchListMatch: sig.watchListMatch ?? false,
              signalSource:
                sig.signalSource === 'arkham'
                  ? 'arkham'
                  : (sig.signalSource ?? 'coinbase_deposit'),
              arkhamEntityBase: sig.arkhamEntityBase,
            };
            const next = isLongSignal
              ? createBlkLongOpenState(
                  price,
                  t,
                  sig.txid,
                  prev.collateralUsd,
                  prev.leverage,
                  chainBtc,
                  meta,
                  prev.lastShortEtDayKey
                )
              : createBlkShortOpenState(
                  price,
                  t,
                  sig.txid,
                  prev.collateralUsd,
                  prev.leverage,
                  chainBtc,
                  meta,
                  prev.lastLongEtDayKey
                );
            queueMicrotask(() => persistBlkProcessedTxids());
            return next;
          }
          return prev;
        });
      } catch {
        /* ignore */
      }
    };
    run();
    const id = setInterval(run, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [liveMode, btcPrice, paperPositionSizeUsd, leverage, persistBlkProcessedTxids]);

  /** BLK paper: one process step per effect; loop catches up multiple covers after idle. */
  useEffect(() => {
    if (liveMode || btcPrice == null || btcTime == null) return;
    let prev = blkPaperStateRef.current;
    const batch: ClosedTrade[] = [];
    for (let step = 0; step < 24; step++) {
      const { state: next, closedTrades } = processBlkPaperTick(prev, btcPrice, btcTime);
      prev = next;
      if (closedTrades.length === 0) break;
      batch.push(...closedTrades);
    }
    blkPaperStateRef.current = prev;
    setBlkPaperState(prev);
    if (batch.length > 0) {
      const enriched = batch.map((t) => ({ ...t, asset: 'btc' as const }));
      setTradesByStrategy((p) => ({
        ...p,
        [BLK_STRATEGY_ID]: [...enriched.reverse(), ...(p[BLK_STRATEGY_ID] ?? [])],
      }));
    }
  }, [btcPrice, btcTime, liveMode]);

  const fetchPrice = useCallback(async () => {
    try {
      const [solRes, btcRes, ethRes] = await Promise.all([
        fetch('/api/solana-bot/price?asset=sol'),
        fetch('/api/solana-bot/price?asset=btc'),
        fetch('/api/solana-bot/price?asset=eth'),
      ]);
      const parseOne = async (res: Response) =>
        parseApiJson<{
          success?: boolean;
          data?: { price?: number; timestamp?: number };
          error?: string;
        }>(res);

      const [solJ, btcJ, ethJ] = await Promise.all([parseOne(solRes), parseOne(btcRes), parseOne(ethRes)]);
      const next: Partial<Record<InsideBarUnderlying, { price: number; time: number }>> = {};
      if (solJ.success && solJ.data?.price != null) {
        next.sol = {
          price: solJ.data.price,
          time: solJ.data.timestamp ?? Math.floor(Date.now() / 1000),
        };
      }
      if (btcJ.success && btcJ.data?.price != null) {
        next.btc = {
          price: btcJ.data.price,
          time: btcJ.data.timestamp ?? Math.floor(Date.now() / 1000),
        };
      }
      if (ethJ.success && ethJ.data?.price != null) {
        next.eth = {
          price: ethJ.data.price,
          time: ethJ.data.timestamp ?? Math.floor(Date.now() / 1000),
        };
      }
      setMarkPrices(next);
      if (next.sol) {
        setPrice(next.sol.price);
        setPriceTime(next.sol.time);
      } else if (next.btc) {
        setPrice(next.btc.price);
        setPriceTime(next.btc.time);
      } else if (next.eth) {
        setPrice(next.eth.price);
        setPriceTime(next.eth.time);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Price fetch failed');
    }
  }, []);

  const fetchOHLCV = useCallback(async () => {
    try {
      const results = await Promise.all(
        INSIDE_BAR_STRATEGIES.map(async (s) => {
          const u = strategyUnderlying(s);
          const res = await fetch(
            `/api/solana-bot/ohlcv?interval=${s.intervalSec}&underlying=${u}`
          );
          const json = await parseApiJson<{
            success?: boolean;
            data?: OHLCVCandle[];
            warmupMinutes?: number;
          }>(res);
          return { id: s.id, json };
        })
      );
      const nextCandles: Record<string, OHLCVCandle[]> = {};
      const nextWarmup: Record<string, number> = {};
      for (const { id, json } of results) {
        if (json.success && Array.isArray(json.data)) {
          nextCandles[id] = json.data;
        }
        if (json.success) nextWarmup[id] = json.warmupMinutes ?? 0;
      }
      setCandlesByStrategy((prev) => ({ ...prev, ...nextCandles }));
      setWarmupByStrategy((prev) => ({ ...prev, ...nextWarmup }));
      setError(null);
      if (useChartPrice) {
        const chartId =
          INSIDE_BAR_STRATEGIES.find((s) => s.id === activeStrategyId)?.id ??
          INSIDE_BAR_STRATEGIES[0].id;
        const chartCandles = nextCandles[chartId];
        if (chartCandles && chartCandles.length > 0) {
          setPrice(chartCandles[0].close);
          setPriceTime(Math.floor(Date.now() / 1000));
        }
        const t = Math.floor(Date.now() / 1000);
        const fromChart: Partial<Record<InsideBarUnderlying, { price: number; time: number }>> = {};
        for (const s of INSIDE_BAR_STRATEGIES) {
          const u = strategyUnderlying(s);
          const c0 = nextCandles[s.id]?.[0]?.close;
          if (typeof c0 === 'number' && c0 > 0 && fromChart[u] == null) {
            fromChart[u] = { price: c0, time: t };
          }
        }
        if (Object.keys(fromChart).length > 0) {
          setMarkPrices((prev) => ({ ...prev, ...fromChart }));
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'OHLCV fetch failed');
    }
  }, [useChartPrice, activeStrategyId]);

  useEffect(() => setMounted(true), []);

  // Initial load and OHLCV polling
  useEffect(() => {
    fetchOHLCV();
    const ohlcvInterval = setInterval(fetchOHLCV, OHLCV_POLL_MS);
    return () => clearInterval(ohlcvInterval);
  }, [fetchOHLCV, useChartPrice]);

  // When switching to chart price, use latest candle close immediately
  useEffect(() => {
    if (useChartPrice && candles.length > 0) {
      setPrice(candles[0].close);
      setPriceTime(Math.floor(Date.now() / 1000));
    }
  }, [useChartPrice, candles]);

  // Pattern detection when candles update (each strategy / bar size) — live mode only; paper uses server tick
  useEffect(() => {
    if (!liveMode) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const patternRefs = {
      entering: Object.fromEntries(
        INSIDE_BAR_STRATEGIES.map((s) => [s.id, enteringRef.current[s.id] ?? false])
      ),
      breakout: Object.fromEntries(
        INSIDE_BAR_STRATEGIES.map((s) => [s.id, { ...breakoutRef.current[s.id] }])
      ),
    };
    setStateByStrategy((prev) => {
      const merged = applyInsideBarPatternFromCandles(
        INSIDE_BAR_STRATEGIES,
        prev,
        candlesByStrategy,
        patternRefs,
        nowSec
      );
      for (const s of INSIDE_BAR_STRATEGIES) {
        breakoutRef.current[s.id] = { ...patternRefs.breakout[s.id] };
      }
      return merged;
    });
  }, [candlesByStrategy, liveMode]);

  // Price polling — live mode only (paper: server /inside-bar/tick advances simulation)
  useEffect(() => {
    if (!liveMode) return;
    const anyActive = INSIDE_BAR_STRATEGIES.some((s) => {
      const st = stateByStrategy[s.id];
      return (
        st?.status === 'pattern_detected' ||
        st?.status === 'in_position' ||
        st?.status === 'reversed'
      );
    });
    const ms = anyActive ? PRICE_POLL_MS : PRICE_POLL_IDLE_MS;
    fetchPrice();
    const id = setInterval(fetchPrice, ms);
    return () => clearInterval(id);
  }, [stateByStrategy, fetchPrice, liveMode]);

  /** Paper mode: server-side inside-bar tick (survives browser sleep / tab suspend). */
  useEffect(() => {
    if (liveMode) return;
    let cancelled = false;

    const run = async () => {
      if (cancelled) return;
      try {
        const clientSnapshot: Partial<InsideBarServerSnapshot> = {
          stateByStrategy: { ...stateByStrategyRef.current },
          entering: Object.fromEntries(
            INSIDE_BAR_STRATEGIES.map((s) => [s.id, enteringRef.current[s.id] ?? false])
          ),
          breakout: Object.fromEntries(
            INSIDE_BAR_STRATEGIES.map((s) => [
              s.id,
              { ...breakoutRef.current[s.id] },
            ])
          ),
          tradesByStrategy: Object.fromEntries(
            INSIDE_BAR_STRATEGIES.map((s) => [s.id, tradesInsideBarRef.current[s.id] ?? []])
          ),
        };
        const res = await fetch('/api/solana-bot/inside-bar/tick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientSnapshot,
            paperPositionSizeUsd: paperPositionSizeUsd,
            useChartPrice,
          }),
        });
        const json = await parseApiJson<{
          success?: boolean;
          data?: {
            snapshot: InsideBarServerSnapshot & { lastTickAt: number };
            price: number;
            priceTime: number;
            pricesByStrategy?: Record<string, { price: number; time: number }>;
            candlesByStrategy: Record<string, OHLCVCandle[]>;
            warmupByStrategy: Record<string, number>;
          };
        }>(res);
        if (!json.success || !json.data || cancelled) return;
        const d = json.data as {
          snapshot: InsideBarServerSnapshot & { lastTickAt: number };
          price: number;
          priceTime: number;
          pricesByStrategy?: Record<string, { price: number; time: number }>;
          candlesByStrategy: Record<string, OHLCVCandle[]>;
          warmupByStrategy: Record<string, number>;
        };
        paperSyncSkipRef.current = true;
        setPrice(d.price);
        setPriceTime(d.priceTime);
        if (d.pricesByStrategy) {
          const mp: Partial<Record<InsideBarUnderlying, { price: number; time: number }>> = {};
          for (const s of INSIDE_BAR_STRATEGIES) {
            const row = d.pricesByStrategy[s.id];
            if (!row) continue;
            const u = strategyUnderlying(s);
            if (mp[u] == null) mp[u] = { price: row.price, time: row.time };
          }
          setMarkPrices(mp);
        }
        setCandlesByStrategy((prev) => ({ ...prev, ...d.candlesByStrategy }));
        setStateByStrategy(d.snapshot.stateByStrategy);
        stateByStrategyRef.current = d.snapshot.stateByStrategy;
        for (const s of INSIDE_BAR_STRATEGIES) {
          enteringRef.current[s.id] = d.snapshot.entering[s.id] ?? false;
          breakoutRef.current[s.id] = { ...d.snapshot.breakout[s.id] };
        }
        setBreakoutByStrategy(
          Object.fromEntries(
            INSIDE_BAR_STRATEGIES.map((s) => [s.id, { ...d.snapshot.breakout[s.id] }])
          )
        );
        setTradesByStrategy((prev) => {
          const next = { ...prev };
          for (const s of INSIDE_BAR_STRATEGIES) {
            next[s.id] = d.snapshot.tradesByStrategy[s.id] ?? [];
          }
          return next;
        });
        setWarmupByStrategy((prev) => ({ ...prev, ...d.warmupByStrategy }));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Inside-bar server sync failed');
      }
    };

    void run();
    const id = setInterval(run, INSIDE_BAR_SERVER_SYNC_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [liveMode, paperPositionSizeUsd, useChartPrice]);

  // Process price for all strategies (per-underlying mark) — live mode only
  useEffect(() => {
    if (!liveMode) return;
    if (paperSyncSkipRef.current) {
      paperSyncSkipRef.current = false;
      return;
    }

    const positionSize = liveMode ? liveAmountToRun : paperPositionSizeUsd;
    const state = { ...stateByStrategyRef.current };
    const newTrades: Record<string, ClosedTrade[]> = {};

    const enrichList = (list: ClosedTrade[], asset: 'sol' | 'btc' | 'eth'): ClosedTrade[] =>
      list.map((closedTrade) => {
        const amt = positionSize / closedTrade.entryPrice;
        const base = {
          ...closedTrade,
          pnlUsd: (closedTrade.pnlPercent / 100) * positionSize,
          asset,
        };
        if (asset === 'btc') return { ...base, btcAmount: amt };
        if (asset === 'eth') return { ...base, ethAmount: amt };
        return { ...base, solAmount: amt };
      });

    const markForStrategy = (s: (typeof INSIDE_BAR_STRATEGIES)[number]) => {
      const c = candlesByStrategy[s.id] ?? [];
      if (useChartPrice && c[0]?.close != null && c[0].close > 0) {
        return { price: c[0].close, time: Math.floor(Date.now() / 1000) };
      }
      const u = strategyUnderlying(s);
      return markPrices[u] ?? null;
    };

    for (const s of INSIDE_BAR_STRATEGIES) {
      const sid = s.id;
      let st = state[sid];
      if (!st) continue;

      const mv = markForStrategy(s);
      if (!mv) continue;
      const { price: px, time: pt } = mv;
      const asset = strategyUnderlying(s);

      if (s.intervalSec === 3600 && isWeekendHalt60mEt(new Date(pt * 1000))) {
        if (st.status === 'in_position') {
          const r = checkPositionExit({ ...st, windowEnd: pt - 1 }, px, pt);
          state[sid] = r.newState;
          if (r.closedTrades.length > 0) newTrades[sid] = r.closedTrades;
          continue;
        }
        if (st.status === 'reversed') {
          const r = checkReversedExit({ ...st, windowEnd: pt - 1 }, px, pt);
          state[sid] = r.newState;
          if (r.closedTrades.length > 0) newTrades[sid] = r.closedTrades;
          continue;
        }
        if (st.status === 'pattern_detected') {
          state[sid] = {
            ...createInitialState(),
            lastTradedCandleUnixTime: st.lastTradedCandleUnixTime,
          };
          enteringRef.current[sid] = false;
          breakoutRef.current[sid] = { long: 0, short: 0 };
        }
        continue;
      }

      if (st.status === 'pattern_detected' && st.setup && !enteringRef.current[sid]) {
        const setup = st.setup;
        const longBreakout = isBreakoutLong(px, setup);
        const shortBreakout = isBreakoutShort(px, setup);
        const bc = breakoutRef.current[sid];

        if (longBreakout) {
          const prevLong = bc.long;
          bc.long += 1;
          bc.short = 0;
          if (prevLong >= 0) {
            enteringRef.current[sid] = true;
            bc.long = 0;
            bc.short = 0;
            st = enterLong(st, px, pt);
            state[sid] = st;
            if (liveMode && connected && (asset === 'sol' || asset === 'btc')) {
              void executeOnBreakout('long', px, sid);
            }
          }
          continue;
        }
        if (shortBreakout) {
          const prevShort = bc.short;
          bc.short += 1;
          bc.long = 0;
          if (prevShort >= 0) {
            enteringRef.current[sid] = true;
            bc.long = 0;
            bc.short = 0;
            st = enterShort(st, px, pt);
            state[sid] = st;
            if (liveMode && connected && (asset === 'sol' || asset === 'btc')) {
              void executeOnBreakout('short', px, sid);
            }
          }
          continue;
        }
        bc.long = 0;
        bc.short = 0;
      }

      if ((st.status === 'idle' || st.status === 'stopped') && enteringRef.current[sid]) {
        enteringRef.current[sid] = false;
      }

      if (st.status === 'in_position') {
        const { newState, closedTrades } = checkPositionExit(st, px, pt);
        state[sid] = newState;
        if (closedTrades.length > 0) {
          newTrades[sid] = closedTrades;
        }
        continue;
      }

      if (st.status === 'reversed') {
        const { newState, closedTrades } = checkReversedExit(st, px, pt);
        state[sid] = newState;
        if (closedTrades.length > 0) {
          newTrades[sid] = closedTrades;
        }
      }
    }

    stateByStrategyRef.current = state;
    setStateByStrategy(state);

    if (Object.keys(newTrades).length > 0) {
      setTradesByStrategy((prev) => {
        const n = { ...prev };
        for (const k of Object.keys(newTrades)) {
          const def = INSIDE_BAR_STRATEGIES.find((x) => x.id === k);
          const asset = def ? strategyUnderlying(def) : 'sol';
          const enriched = enrichList(newTrades[k], asset).reverse();
          n[k] = [...enriched, ...(prev[k] ?? [])];
        }
        return n;
      });
    }

    setBreakoutByStrategy(() => {
      const br: Record<string, { long: number; short: number }> = {};
      for (const s of INSIDE_BAR_STRATEGIES) {
        br[s.id] = { ...breakoutRef.current[s.id] };
      }
      return br;
    });
  }, [
    markPrices,
    candlesByStrategy,
    useChartPrice,
    liveMode,
    connected,
    executeOnBreakout,
    paperPositionSizeUsd,
    liveAmountToRun,
  ]);

  const blkTrades = tradesByStrategy[BLK_STRATEGY_ID] ?? [];
  const blkMetrics = computeBlkMetrics(blkTrades);
  const blkSessionOpenCount = blkTrades.filter((t) => t.exitReason === 'blk_open').length;
  const metrics = isBlkTab ? blkMetrics : computeMetrics(trades);
  const totalPnlAllStrategies =
    INSIDE_BAR_STRATEGIES.reduce(
      (sum, s) => sum + computeMetrics(tradesByStrategy[s.id] ?? []).totalPnl,
      0
    ) + computeBlkMetrics(tradesByStrategy[BLK_STRATEGY_ID] ?? []).totalPnl;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2 items-center border-b border-gray-100 pb-3">
              <span className="text-xs text-gray-500 self-center mr-1">Strategy:</span>
              {TRADE_STRATEGIES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setActiveStrategyId(s.id)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                    activeStrategyId === s.id
                      ? 'bg-primary-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between flex-wrap gap-4">
              <h1 className="text-2xl font-bold text-gray-900">Jupiter Perps — inside bar</h1>
              <div className="flex items-center gap-4">
                {connected && (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-600">Mode:</span>
                    <button
                      type="button"
                      onClick={() => setLiveMode(false)}
                      className={`px-3 py-1 rounded text-sm font-medium ${
                        !liveMode ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      Paper
                    </button>
                    <button
                      type="button"
                      onClick={() => setLiveMode(true)}
                      className={`px-3 py-1 rounded text-sm font-medium ${
                        liveMode ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                      }`}
                    >
                      Live
                    </button>
                  </div>
                )}
                {mounted && <WalletMultiButton />}
                <nav className="flex gap-2">
                  <a href="/" className="text-sm text-gray-600 hover:text-gray-900">
                    Option Max Pain
                  </a>
                  <span className="text-sm text-gray-400">|</span>
                  <span className="text-sm font-medium text-primary-600">Trade</span>
                  <span className="text-sm text-gray-400">|</span>
                  <a href="/backtest" className="text-sm text-gray-600 hover:text-gray-900">
                    Backtest
                  </a>
                  <span className="text-sm text-gray-400">|</span>
                  <a href="/ibit" className="text-sm text-gray-600 hover:text-gray-900">
                    IBIT
                  </a>
                </nav>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <p className="text-sm text-gray-600 mb-4">
          {isBlkTab ? (
            <>
              <span className="font-semibold">BLK</span> — paper short = your position size ($
              {paperPositionSizeUsd.toFixed(0)}); on-chain BTC to Coinbase is shown for signal context only.
              Short: {BLK_COVER_SLOT_COUNT_MORNING} covers <span className="font-semibold">10:00–12:50 ET</span> if the
              signal is before 10am ET;{' '}
              {BLK_COVER_SLOT_COUNT_AFTERNOON} covers <span className="font-semibold">3:00–3:50 ET</span> if the
              signal is from 10am onward. Long (2nd CB→BR batch): {BLK_LONG_COVER_SLOT_COUNT} sells{' '}
              <span className="font-semibold">2:00–3:40 ET</span> (within 2:00–3:45 PM); no new long signal after{' '}
              <span className="font-semibold">2:00 PM ET</span>. Pyth BTC. Signals from{' '}
              <code className="text-xs bg-gray-100 px-1">/api/…/ibit/poll</code> (paper mode only).
            </>
          ) : (
            <>
              Viewing <span className="font-semibold">{intervalLabel(activeIntervalSec)}</span> on{' '}
              <span className="font-semibold">{assetLabel}</span> · Each tab keeps its own state, trade log,
              and performance (${paperPositionSizeUsd.toFixed(0)} / strategy in paper mode). Paper inside-bar
              logic runs on the server every few seconds.{' '}
              <span className="font-medium">60m</span> tabs pause Fri 5pm–Sun 3pm ET (flatten open);{' '}
              <span className="font-medium">Daily</span> tabs run continuously. Live auto-execution: SOL +
              WBTC perps only (ETH tabs = paper until wired).
            </>
          )}
        </p>
        {!isBlkTab && warmupMinutes > 0 && candles.length < 4 && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-amber-800 font-medium">Building candle history</p>
            <p className="text-amber-700 text-sm mt-1">
              Price feed is live. First {intervalLabel(activeIntervalSec)} pattern in{' '}
              {formatWarmupEstimate(activeIntervalSec, warmupMinutes)} (need 4 completed{' '}
              {intervalLabel(activeIntervalSec)} candles).
              {activeIntervalSec === 86400 && (
                <>
                  {' '}
                  Each daily bar is one 8pm–7:59pm ET session (~24h). Set{' '}
                  <code className="text-xs bg-amber-100 px-1">BIRDEYE_API_KEY</code> on the server to
                  backfill and skip most of this wait after restarts.
                </>
              )}
            </p>
          </div>
        )}

        <div className="mb-6 p-4 bg-slate-50 border border-slate-200 rounded-lg">
          <p className="text-slate-800 font-medium mb-3">
            {liveMode ? 'Live Trading' : 'Paper Trading'} Settings
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
            {!liveMode && (
              <>
                <div>
                  <label className="block text-sm text-slate-600 mb-1">Starting Balance ($)</label>
                  <input
                    type="number"
                    min={1}
                    value={paperStartingBalance}
                    onChange={(e) => setPaperStartingBalance(Number(e.target.value) || 1000)}
                    className="w-full px-3 py-2 border border-slate-300 rounded text-sm"
                  />
                </div>
                <div className="flex items-end">
                  <div>
                    <span className="text-sm text-slate-600">Current Balance: </span>
                    <span className="font-semibold text-slate-900">
                      ${(paperStartingBalance + totalPnlAllStrategies).toFixed(2)}
                    </span>
                  </div>
                </div>
              </>
            )}
            <div>
              <label className="block text-sm text-slate-600 mb-1">Position Size ($)</label>
              <input
                type="number"
                min={1}
                value={paperPositionSizeUsd}
                onChange={(e) => setPaperPositionSizeUsd(Number(e.target.value) || 1000)}
                className="w-full px-3 py-2 border border-slate-300 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">Leverage</label>
              <input
                type="number"
                min={1}
                max={100}
                step={0.1}
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value) || 1.5)}
                className="w-full px-3 py-2 border border-slate-300 rounded text-sm"
              />
              <p className="text-xs text-slate-500 mt-1">Used for live trades (e.g. 1.5x)</p>
            </div>
          </div>
        </div>

        {liveMode && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg space-y-4">
            {connected && (
              <div>
                <p className="text-green-800 font-medium">Live trading enabled</p>
                <p className="text-green-700 text-sm mt-1">
                  Breakouts will trigger Jupiter Perps execution via Solflare. Shorts require USDC collateral.
                  Uses request-fulfillment model (keepers execute).
                </p>
              </div>
            )}
            <div>
              <label className="block text-sm text-green-800 font-medium mb-1">
                Amount to run ($)
              </label>
              <input
                type="number"
                min={1}
                value={liveAmountToRun}
                onChange={(e) => setLiveAmountToRun(Number(e.target.value) || 1000)}
                className="w-40 px-3 py-2 border border-green-300 rounded text-sm bg-white"
              />
              <p className="text-green-700 text-xs mt-1">
                Dollar amount to use per trade (e.g. $1,000 of your $5,000 balance)
              </p>
            </div>
          </div>
        )}

        {execError && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800">
            {execError}
          </div>
        )}

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
            {error}
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-8">
          {/* Left: Status & Monitoring */}
          <div className="space-y-6">
            <section className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Status & Monitoring</h2>
              {isBlkTab ? (
                <div className="space-y-4 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">BLK status</span>
                    <span
                      className={`font-medium px-2 py-0.5 rounded ${
                        blkPaperState.status === 'idle' ? 'bg-gray-100' : 'bg-primary-100 text-primary-800'
                      }`}
                    >
                      {(() => {
                        const todayK = getEtDayKey(new Date());
                        const shortToday =
                          blkPaperState.lastShortEtDayKey != null &&
                          blkPaperState.lastShortEtDayKey === todayK;
                        const longToday =
                          blkPaperState.lastLongEtDayKey != null &&
                          blkPaperState.lastLongEtDayKey === todayK;
                        if (blkPaperState.status === 'idle' && shortToday && longToday) {
                          return 'idle (short & long done today — no new BLK session until next ET day)';
                        }
                        if (blkPaperState.status === 'idle' && shortToday && !longToday) {
                          return 'idle (short done today — long may still signal)';
                        }
                        if (blkPaperState.status === 'idle' && longToday && !shortToday) {
                          return 'idle (long done today — short may still signal)';
                        }
                        if (blkPaperState.status === 'idle') return 'idle (watching IBIT)';
                        if (blkPaperState.status === 'long_open') return 'long open (scaling out)';
                        return 'short open (covering)';
                      })()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">BTC (Pyth)</span>
                    <span className="font-mono font-medium">
                      {btcPrice != null ? `$${formatPrice(btcPrice)}` : '—'}
                    </span>
                  </div>
                  {(blkPaperState.status === 'short_open' || blkPaperState.status === 'long_open') &&
                    blkPaperState.entryBtc != null && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-600">
                          {blkPaperState.status === 'long_open' ? 'Long entry' : 'Short entry'}
                        </span>
                        <span className="font-mono">${formatPrice(blkPaperState.entryBtc)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">
                          {blkPaperState.status === 'long_open' ? 'Paper long (sim)' : 'Paper short (sim)'}
                        </span>
                        <span className="font-mono">
                          {blkPaperState.paperShortBtc.toFixed(6)} BTC (~$
                          {blkPaperState.notionalUsd.toFixed(0)} notional = ${blkPaperState.collateralUsd.toFixed(0)}{' '}
                          × {blkPaperState.leverage}×)
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">On-chain (signal, audit)</span>
                        <span className="font-mono">
                          {blkPaperState.chainMainOutBtc.toFixed(4)} BTC
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Per cover slice (BTC)</span>
                        <span className="font-mono">
                          {(
                            blkPaperState.paperShortBtc /
                            Math.max(
                              1,
                              blkPaperState.coverSliceCount ||
                                (blkPaperState.status === 'long_open'
                                  ? BLK_LONG_COVER_SLOT_COUNT
                                  : BLK_COVER_SLICES)
                            )
                          ).toFixed(6)}{' '}
                          BTC
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Cover progress</span>
                        <span className="font-mono">
                          {blkPaperState.nextSliceIndex}/
                          {Math.max(
                            1,
                            blkPaperState.coverSliceCount ||
                              (blkPaperState.status === 'long_open'
                                ? BLK_LONG_COVER_SLOT_COUNT
                                : BLK_COVER_SLICES)
                          )}{' '}
                          slices (
                          {blkPaperState.status === 'long_open'
                            ? '2:00–3:45 ET'
                            : blkPaperState.coverSliceCount === BLK_COVER_SLOT_COUNT_AFTERNOON
                              ? '3:00–4:00 ET'
                              : '10:00–12:50 ET'}
                          )
                        </span>
                      </div>
                      {blkPaperState.ibitSignalSource && (
                        <p className="text-xs text-gray-500">
                          Detection:{' '}
                          <span className="font-mono">
                            {blkPaperState.ibitSignalSource === 'coinbase_deposit'
                              ? 'Coinbase deposit (large in) → sender from inputs'
                              : blkPaperState.ibitSignalSource === 'arkham'
                                ? `Arkham (entity out) → Blockstream validate${
                                    blkPaperState.ibitArkhamEntityBase
                                      ? ` · base=${blkPaperState.ibitArkhamEntityBase}`
                                      : ''
                                  }`
                                : blkPaperState.ibitSignalSource}
                          </span>
                          {blkPaperState.ibitWatchListMatch ? ' · watch-list match' : ''}
                        </p>
                      )}
                      {blkPaperState.ibitPrimarySourceAddress && (
                        <p className="text-xs text-gray-500 break-all">
                          Primary input (feeder): {blkPaperState.ibitPrimarySourceAddress}
                        </p>
                      )}
                      {blkPaperState.ibitInputSourceAddresses.length > 0 && (
                        <p className="text-xs text-gray-500 break-all">
                          All input addresses: {blkPaperState.ibitInputSourceAddresses.join(', ')}
                        </p>
                      )}
                      {blkPaperState.signalTxid && (
                        <p className="text-xs text-gray-500 break-all">
                          Signal tx: {blkPaperState.signalTxid}
                        </p>
                      )}
                    </>
                  )}
                  <div className="pt-2 border-t border-gray-100">
                    <button
                      type="button"
                      onClick={() => {
                        if (
                          typeof window !== 'undefined' &&
                          !window.confirm(
                            'Clear BLK trade log, performance, and session state? (60m/Daily tabs are unchanged.)'
                          )
                        ) {
                          return;
                        }
                        clearBlkPaperHistory();
                      }}
                      className="text-sm px-3 py-1.5 rounded border border-slate-300 text-slate-700 hover:bg-slate-50"
                    >
                      Clear BLK log &amp; start fresh
                    </button>
                    <p className="text-xs text-gray-500 mt-2">
                      Resets paper BLK trades, metrics, and processed signal ids so past txids can signal again.
                    </p>
                  </div>
                  <p className="text-xs text-gray-500">
                    Paper only. Live mode does not auto-trade BLK here.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Status</span>
                    <span
                      className={`font-medium px-2 py-0.5 rounded ${
                        state.status === 'idle'
                          ? 'bg-gray-100'
                          : state.status === 'pattern_detected'
                          ? 'bg-amber-100 text-amber-800'
                          : state.status === 'in_position' || state.status === 'reversed'
                          ? 'bg-primary-100 text-primary-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {state.status.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">{assetLabel} price (last candle)</span>
                    <span className="font-mono font-medium">
                      {candles.length > 0 ? `$${formatPrice(candles[0].close)}` : '—'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {activeUnderlying === 'sol' ? 'Doves oracle' : 'Pyth'} — last{' '}
                    {intervalLabel(activeIntervalSec)} close
                  </p>
                  <div className="flex justify-between">
                    <span className="text-gray-600">{assetLabel} price (live)</span>
                    <span className="font-mono font-medium">
                      {liveMark != null ? `$${formatPrice(liveMark.price)}` : '—'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    {activeUnderlying === 'sol'
                      ? 'Doves / Pyth (SOL) — matches Jupiter SOL perp execution'
                      : 'Pyth USD mark — pattern + paper sim; live auto-exec: SOL + WBTC perps only'}
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useChartPrice}
                      onChange={(e) => setUseChartPrice(e.target.checked)}
                      className="rounded"
                    />
                    <span className="text-sm text-gray-600">
                      Use chart price for breakouts (last {intervalLabel(activeIntervalSec)} close)
                    </span>
                  </label>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Position</span>
                    <span className="font-medium">
                      {state.position ? (
                        <span className={state.position === 'long' ? 'text-green-600' : 'text-red-600'}>
                          {state.position.toUpperCase()}
                        </span>
                      ) : (
                        '—'
                      )}
                    </span>
                  </div>
                  {state.entryPrice != null && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Entry</span>
                      <span className="font-mono">${formatPrice(state.entryPrice)}</span>
                    </div>
                  )}
                  {state.windowEnd != null && (
                    <div className="flex justify-between">
                      <span className="text-gray-600">Window ends</span>
                      <span className="font-mono">{formatTime(state.windowEnd)}</span>
                    </div>
                  )}
                </div>
              )}
            </section>

            {!isBlkTab && state.setup && (
              <section className="bg-white rounded-lg shadow-md p-6">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Pattern Levels</h2>
                {state.setup.candleUnixTime != null && (
                  <p className="text-xs text-gray-500 mb-2">
                    From candle {formatTime(state.setup.candleUnixTime)} (first row in Recent Candles)
                  </p>
                )}
                <div className="space-y-2 font-mono text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Breakout High (Long)</span>
                    <span>${formatPrice(state.setup.breakoutHigh)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Breakout Low (Short)</span>
                    <span>${formatPrice(state.setup.breakoutLow)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Range</span>
                    <span>${formatPrice(state.setup.range)}</span>
                  </div>
                  <div className="flex justify-between border-t pt-2">
                    <span className="text-gray-600">TP Long{state.entryPrice ? ' (fee-adj)' : ''}</span>
                    <span className="text-green-600">$
                      {formatPrice(
                        state.entryPrice
                          ? getEffectiveTpLong(state.entryPrice, state.setup.range)
                          : state.setup.tpLong
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">TP Short{state.entryPrice ? ' (fee-adj)' : ''}</span>
                    <span className="text-red-600">$
                      {formatPrice(
                        state.entryPrice
                          ? getEffectiveTpShort(state.entryPrice, state.setup.range)
                          : state.setup.tpShort
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Stop Short (reversal)</span>
                    <span>${formatPrice(state.setup.stopShort)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Stop Long (reversal)</span>
                    <span>${formatPrice(state.setup.stopLong)}</span>
                  </div>
                </div>
              </section>
            )}
          </div>

          {/* Right: PnL & Metrics */}
          <div className="space-y-6">
            <section className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Performance</h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-gray-600 text-sm">Total PnL</p>
                  <p
                    className={`text-xl font-bold ${
                      metrics.totalPnl >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    ${metrics.totalPnl >= 0 ? '+' : ''}{formatPrice(metrics.totalPnl)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-600 text-sm">Win Rate</p>
                  <p className="text-xl font-bold">{metrics.winRate.toFixed(1)}%</p>
                </div>
                <div>
                  <p className="text-gray-600 text-sm">Wins / Losses</p>
                  <p className="text-xl font-bold">
                    {metrics.wins} / {metrics.losses}
                  </p>
                </div>
                <div>
                  <p className="text-gray-600 text-sm">Sharpe Ratio</p>
                  <p className="text-xl font-bold">{metrics.sharpeRatio.toFixed(2)}</p>
                </div>
                <div className="col-span-2 border-t border-gray-100 pt-3 mt-1">
                  <p className="text-gray-600 text-sm">Est. total trading costs</p>
                  <p className="text-xl font-bold text-slate-800">
                    ${formatPrice(metrics.estimatedTotalFeesUsd)}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {isBlkTab ? (
                      <>
                        Running total: {metrics.feeLegCount} fee legs (
                        {blkSessionOpenCount} session open{blkSessionOpenCount === 1 ? '' : 's'} × 2 +{' '}
                        {metrics.totalTrades} cover round-turn{metrics.totalTrades === 1 ? '' : 's'} × 2) at ~
                        {JUPITER_PERPS_EST_FEE_BPS_PER_SIDE} bps per side. Win rate counts cover slices only.
                      </>
                    ) : (
                      <>
                        Running total: {metrics.feeLegCount} fee legs (
                        {metrics.totalTrades} opens + {metrics.totalTrades} closes) at ~
                        {JUPITER_PERPS_EST_FEE_BPS_PER_SIDE} bps per side (taker, Jupiter Perps).
                      </>
                    )}{' '}
                    Not net PnL—actual fees depend on tier and maker/taker mix.
                  </p>
                </div>
              </div>
            </section>

            <section className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Trade Log</h2>
                  <p className="text-xs text-gray-500 mb-3">
                {isBlkTab
                  ? 'Session open (paper short) then 18 cover round-turns (short + buy per slice) with PnL each.'
                  : 'Entry: position size @ price · time · Exit: price · time · PnL'}
              </p>
              <div className="max-h-80 overflow-y-auto space-y-3">
                {trades.length === 0 ? (
                  <p className="text-gray-500 text-sm">No closed trades yet</p>
                ) : (
                  trades.map((t) => (
                    <div
                      key={t.id}
                      className="p-4 border border-gray-200 rounded-lg text-sm space-y-3 bg-gray-50/50"
                    >
                      <div className="flex justify-between items-center border-b border-gray-200 pb-2">
                        <span
                          className={`font-semibold ${
                            t.side === 'long' ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {t.exitReason === 'blk_open'
                            ? 'SESSION OPEN'
                            : t.exitReason === 'blk_cover'
                              ? `COVER ${t.blkSliceIndex != null ? t.blkSliceIndex + 1 : '?'}/${
                                  t.blkCoverSliceTotal ?? BLK_COVER_SLICES
                                }`
                              : t.side?.toUpperCase()}
                        </span>
                        <span className="text-gray-500 text-xs">
                          {t.exitReason === 'blk_open'
                            ? 'short (paper size)'
                            : t.exitReason === 'blk_cover'
                              ? 'round-turn'
                              : t.exitReason}
                        </span>
                      </div>
                      <div className="grid gap-2">
                        {t.exitReason === 'blk_open' ? (
                          <>
                            <p className="text-gray-700">
                              Short <span className="font-mono">{t.btcAmount?.toFixed(6)} BTC</span> @{' '}
                              <span className="font-mono">${formatPrice(t.entryPrice)}</span>
                              <span className="text-gray-500 font-mono text-xs">
                                {' · '}
                                {formatTime(t.entryTime)}
                              </span>
                            </p>
                            {t.chainMainOutBtc != null && t.chainMainOutBtc > 0 && (
                              <p className="text-xs text-gray-500">
                                Signal on-chain to Coinbase (main output):{' '}
                                <span className="font-mono">{t.chainMainOutBtc.toFixed(4)} BTC</span> — paper
                                size uses your position $ above.
                              </p>
                            )}
                            {t.ibitPrimarySourceAddress && (
                              <p className="text-xs text-gray-500 break-all">
                                Sender (largest input): {t.ibitPrimarySourceAddress}
                                {t.ibitWatchListMatch ? ' · matched legacy watch list' : ''}
                              </p>
                            )}
                            {t.ibitInputSourceAddresses && t.ibitInputSourceAddresses.length > 0 && (
                              <p className="text-xs text-gray-500 break-all">
                                Input addresses: {t.ibitInputSourceAddresses.join(', ')}
                              </p>
                            )}
                            <p className="text-xs text-gray-500">
                              PnL accrues on cover rows below (one row per 10m slot).
                            </p>
                          </>
                        ) : t.exitReason === 'blk_cover' ? (
                          <>
                            <div className="flex flex-wrap gap-x-2">
                              <span className="text-gray-600 font-medium">Short leg:</span>
                              <span>
                                {t.asset === 'btc' && t.btcAmount != null
                                  ? `${t.btcAmount.toFixed(6)} BTC`
                                  : '—'}
                                {' @ $'}
                                <span className="font-mono">{formatPrice(t.entryPrice)}</span>
                              </span>
                              {t.entryTime != null && (
                                <span className="text-gray-500 font-mono text-xs">
                                  {formatTime(t.entryTime)}
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-x-2">
                              <span className="text-gray-600 font-medium">Cover (buy):</span>
                              <span>
                                {t.asset === 'btc' && t.btcAmount != null
                                  ? `${t.btcAmount.toFixed(6)} BTC`
                                  : '—'}{' '}
                                @ <span className="font-mono">${formatPrice(t.exitPrice)}</span>
                              </span>
                              <span className="text-gray-500 font-mono text-xs">
                                {formatTime(t.exitTime)}
                              </span>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="text-gray-700">
                              {t.side === 'long' ? 'Long' : 'Short'}{' '}
                              <span className="font-mono">
                                {t.asset === 'btc' && t.btcAmount != null
                                  ? `${t.btcAmount.toFixed(6)} BTC`
                                  : t.asset === 'eth' && t.ethAmount != null
                                    ? `${t.ethAmount.toFixed(4)} ETH`
                                    : t.solAmount != null
                                      ? `${t.solAmount.toFixed(4)} SOL`
                                      : '—'}
                              </span>{' '}
                              @ <span className="font-mono">${formatPrice(t.entryPrice)}</span>
                              <span className="text-gray-500 font-mono text-xs">
                                {' · '}
                                {formatTime(t.entryTime)}
                              </span>
                            </p>
                            <p className="text-gray-700">
                              Exit: <span className="font-mono">${formatPrice(t.exitPrice)}</span>
                              <span className="text-gray-500 font-mono text-xs">
                                {' · '}
                                {formatTime(t.exitTime)}
                              </span>
                            </p>
                          </>
                        )}
                        {t.exitReason !== 'blk_open' && t.exitReason !== 'blk_cover' && (
                          <div
                            className={`font-mono font-semibold pt-1 ${
                              t.pnl >= 0 ? 'text-green-600' : 'text-red-600'
                            }`}
                          >
                            PnL:{' '}
                            {t.pnlUsd != null
                              ? `${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)}`
                              : `${t.pnl >= 0 ? '+' : ''}$${formatPrice(t.pnl)}`}
                            {' '}({t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(2)}%)
                          </div>
                        )}
                        {t.exitReason === 'blk_cover' && (
                          <div
                            className={`font-mono font-semibold pt-1 ${
                              t.pnl >= 0 ? 'text-green-600' : 'text-red-600'
                            }`}
                          >
                            Slice PnL:{' '}
                            {t.pnlUsd != null
                              ? `${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)}`
                              : `${t.pnl >= 0 ? '+' : ''}$${formatPrice(t.pnl)}`}
                            {' '}({t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(2)}%)
                          </div>
                        )}
                        {t.exitReason === 'blk_open' && (
                          <div className="font-mono text-gray-600 pt-1">Slice PnL: $0.00 (open)</div>
                        )}
                        {t.asset === 'btc' && t.ibitSignalTxid && (
                          <p className="text-xs text-gray-500 break-all pt-1">
                            IBIT signal (BTC tx): {t.ibitSignalTxid}
                          </p>
                        )}
                        {t.setup && (
                          <div className="pt-2 border-t border-gray-200">
                            <button
                              type="button"
                              onClick={() =>
                                setAuditExpanded((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(t.id)) next.delete(t.id);
                                  else next.add(t.id);
                                  return next;
                                })
                              }
                              className="text-xs text-primary-600 hover:underline font-medium"
                            >
                              {auditExpanded.has(t.id) ? 'Hide Audit' : 'Trade Audit'}
                            </button>
                            {auditExpanded.has(t.id) && (
                              <div className="mt-2 p-3 bg-white rounded border border-gray-200 text-xs space-y-2">
                                <p className="font-semibold text-gray-700">Pattern & Breakout</p>
                                <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono">
                                  <span>Breakout High (long trigger):</span>
                                  <span>${formatPrice(t.setup.breakoutHigh)}</span>
                                  <span>Breakout Low (short trigger):</span>
                                  <span>${formatPrice(t.setup.breakoutLow)}</span>
                                  <span>Range:</span>
                                  <span>${formatPrice(t.setup.range)}</span>
                                  {t.setup.periodEnd != null && t.setup.barDurationSec != null && (
                                    <>
                                      <span>Window ends (pattern + 2 bars):</span>
                                      <span>
                                        {formatTime(
                                          t.setup.periodEnd + t.setup.barDurationSec * 2
                                        )}
                                      </span>
                                    </>
                                  )}
                                  <span>TP Long:</span>
                                  <span className="text-green-600">${formatPrice(t.setup.tpLong)}</span>
                                  <span>TP Short:</span>
                                  <span className="text-red-600">${formatPrice(t.setup.tpShort)}</span>
                                </div>
                                <p className="font-semibold text-gray-700 mt-2">Trigger Check</p>
                                {t.side === 'long' ? (
                                  <p>
                                    Long triggers when price &gt; ${formatPrice(t.setup.breakoutHigh)}.
                                    Entry ${formatPrice(t.entryPrice)} —{' '}
                                    {t.entryPrice > t.setup.breakoutHigh ? (
                                      <span className="text-green-600">OK (above breakout)</span>
                                    ) : (
                                      <span className="text-amber-600">Check: entry not above breakout high</span>
                                    )}
                                  </p>
                                ) : (
                                  <p>
                                    Short triggers when price &lt; ${formatPrice(t.setup.breakoutLow)}.
                                    Entry ${formatPrice(t.entryPrice)} —{' '}
                                    {t.entryPrice < t.setup.breakoutLow ? (
                                      <span className="text-green-600">OK (below breakout)</span>
                                    ) : (
                                      <span className="text-amber-600">Possible false signal: entry not below breakout low</span>
                                    )}
                                  </p>
                                )}
                                <p className="font-semibold text-gray-700 mt-2">Exit</p>
                                <p>
                                  Exited at ${formatPrice(t.exitPrice)} ({t.exitReason}).
                                  {t.exitReason === 'reverse' && (
                                    <span className="text-gray-600">
                                      {' '}
                                      (first leg closed at opposite breakout; second leg continues as
                                      reversed position.)
                                    </span>
                                  )}
                                </p>
                                {t.exitReason === 'time' && t.entryTime != null && (
                                  <div className="mt-2 space-y-1 text-gray-600">
                                    <p>
                                      Management window ends at{' '}
                                      {formatTime(tradeManagementWindowEndUnix(t))} (pattern period
                                      end + 2 bar lengths; not from entry execution).
                                      Actual hold:{' '}
                                      {formatHoldDuration(t.entryTime, t.exitTime)}.
                                    </p>
                                    {t.exitTime > tradeManagementWindowEndUnix(t) + 60 ? (
                                      <p className="text-amber-800">
                                        This exit was <strong>delayed</strong>: the simulator only
                                        closes on a new price tick. If the tab was in the background,
                                        the PC slept, or the network dropped, ticks can pause for a
                                        long time—so &quot;time&quot; exit can happen far after the
                                        management window, using the price from the first tick that
                                        finally ran.
                                      </p>
                                    ) : (
                                      <p>
                                        Exit price is from the live feed at the first poll after the
                                        window ended.
                                      </p>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                {isBlkTab ? 'Recent Candles' : `Recent Candles (${intervalLabel(activeIntervalSec)})`}
              </h2>
              {isBlkTab ? (
                <p className="text-sm text-gray-600">
                  BLK does not use SOL OHLC candles. IBIT signals use Pyth BTC; see Status above.
                </p>
              ) : (
                <>
                  <p className="text-xs text-gray-500 mb-2">
                    {activeUnderlying === 'sol'
                      ? 'SOL: Doves oracle (Jupiter Perps), advanced on server ticks.'
                      : 'Pyth USD mark — aligned with perp reference pricing.'}{' '}
                    Exchange charts may differ slightly.
                  </p>
                  <div className="text-sm overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="text-left text-gray-600">
                          <th className="py-1 pr-2">Time</th>
                          <th className="py-1 pr-2">O</th>
                          <th className="py-1 pr-2">H</th>
                          <th className="py-1 pr-2">L</th>
                          <th className="py-1">C</th>
                        </tr>
                      </thead>
                      <tbody>
                        {candles.slice(0, 6).map((c, i) => (
                          <tr key={c.unixTime || i} className="border-t border-gray-100">
                            <td className="py-1 pr-2 font-mono">{formatTime(c.unixTime)}</td>
                            <td className="py-1 pr-2 font-mono">{formatPrice(c.open)}</td>
                            <td className="py-1 pr-2 font-mono">{formatPrice(c.high)}</td>
                            <td className="py-1 pr-2 font-mono">{formatPrice(c.low)}</td>
                            <td className="py-1 font-mono">{formatPrice(c.close)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </div>
        </div>

        <p className="mt-8 text-center text-sm text-gray-500">
          Connect Solflare for Live mode. Paper mode runs simulation only. Jupiter Perps execution
          via request-fulfillment (keepers).
        </p>
      </main>
    </div>
  );
}
