'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { VersionedTransaction } from '@solana/web3.js';
import { detectPattern, isBreakoutLong, isBreakoutShort } from '@/lib/solana-bot/pattern-engine';
import {
  createInitialState,
  createPatternDetectedState,
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
} from '@/lib/solana-bot/strategy-tabs';
import { intervalLabel } from '@/lib/solana-bot/candle-intervals';
import {
  BLK_STRATEGY_ID,
  BLK_COVER_SLICES,
  BLK_DEFAULT_NOTIONAL_USD,
  createBlkInitialState,
  createBlkShortOpenState,
  processBlkPaperTick,
  type BlkPaperState,
} from '@/lib/solana-bot/blk-paper';

const PRICE_POLL_MS = 1000;   // When pattern detected or in position
const OHLCV_POLL_MS = 60000;  // Check for new candles every minute
const PRICE_POLL_IDLE_MS = 10000; // When idle, poll less often

/** Survive navigate away + back (e.g. /mean-reversion) in the same tab */
const TRADE_SESSION_STORAGE_KEY = 'solana-bot-trade-session-v2';

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
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
  const stateByStrategyRef = useRef(stateByStrategy);
  const breakoutRef = useRef<Record<string, { long: number; short: number }>>(
    Object.fromEntries(INSIDE_BAR_STRATEGIES.map((s) => [s.id, { long: 0, short: 0 }]))
  );

  const [blkPaperState, setBlkPaperState] = useState<BlkPaperState>(createBlkInitialState);
  const blkPaperStateRef = useRef(blkPaperState);
  blkPaperStateRef.current = blkPaperState;
  const blkProcessedSignalsRef = useRef<Set<string>>(new Set());
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [btcTime, setBtcTime] = useState<number | null>(null);

  useEffect(() => {
    stateByStrategyRef.current = stateByStrategy;
  }, [stateByStrategy]);

  const [sessionHydrated, setSessionHydrated] = useState(false);

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
      if (p.blkPaperState) setBlkPaperState(p.blkPaperState);
      if (p.entering) {
        for (const s of INSIDE_BAR_STRATEGIES) {
          enteringRef.current[s.id] = p.entering[s.id] ?? false;
        }
      }
      if (p.blkProcessedSignals?.length) {
        blkProcessedSignalsRef.current = new Set(p.blkProcessedSignals);
      }
    } catch {
      /* ignore corrupt storage */
    }
    setSessionHydrated(true);
  }, []);

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
  const state = stateByStrategy[activeStrategyId] ?? createInitialState();
  const candles = isBlkTab ? [] : (candlesByStrategy[activeStrategyId] ?? []);
  const trades = isBlkTab
    ? (tradesByStrategy[BLK_STRATEGY_ID] ?? [])
    : (tradesByStrategy[activeStrategyId] ?? []);
  const warmupMinutes = isBlkTab ? 0 : (warmupByStrategy[activeStrategyId] ?? 0);
  const breakoutConfirmCount = breakoutByStrategy[activeStrategyId] ?? { long: 0, short: 0 };

  const executeOnBreakout = useCallback(
    async (side: 'long' | 'short', solPrice: number, strategyId: string) => {
      if (!publicKey || !wallet?.adapter) return;
      setExecError(null);
      const sizeUsd = liveAmountByStrategyRef.current[strategyId] ?? liveAmountToRun;
      try {
        const res = await fetch('/api/solana-bot/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side,
          owner: publicKey.toString(),
          sizeUsd,
          leverage,
          solPrice: side === 'long' ? solPrice : undefined,
        }),
        });
        const json = await res.json();
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
    liveAmountByStrategyRef.current[BLK_STRATEGY_ID] = BLK_DEFAULT_NOTIONAL_USD;
  }, [liveAmountToRun]);

  const fetchBtcPrice = useCallback(async () => {
    try {
      const res = await fetch('/api/solana-bot/price?asset=btc');
      const json = await res.json();
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

  /** IBIT poll → paper short $1k BTC when signal (paper only). */
  useEffect(() => {
    if (liveMode || btcPrice == null || btcPrice <= 0) return;
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch('/api/solana-bot/ibit/poll');
        const json = await res.json();
        if (!json.success || !json.data?.signals || cancelled) return;
        const signals = json.data.signals as Array<{
          txid: string;
          blockTime: number;
          mainOutBtc: number;
        }>;
        const price = btcPrice;
        setBlkPaperState((prev) => {
          if (prev.status !== 'idle') return prev;
          for (const sig of signals) {
            if (blkProcessedSignalsRef.current.has(sig.txid)) continue;
            blkProcessedSignalsRef.current.add(sig.txid);
            const t = sig.blockTime > 0 ? sig.blockTime : Math.floor(Date.now() / 1000);
            const chainBtc =
              typeof sig.mainOutBtc === 'number' && sig.mainOutBtc > 0
                ? sig.mainOutBtc
                : BLK_DEFAULT_NOTIONAL_USD / price;
            return createBlkShortOpenState(price, t, sig.txid, chainBtc * price, chainBtc);
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
  }, [liveMode, btcPrice]);

  /** BLK paper: cover slices on BTC ticks. */
  useEffect(() => {
    if (liveMode || btcPrice == null || btcTime == null) return;
    const prev = blkPaperStateRef.current;
    const { state: next, closedTrades } = processBlkPaperTick(prev, btcPrice, btcTime);
    if (next !== prev) setBlkPaperState(next);
    if (closedTrades.length > 0) {
      const enriched = closedTrades.map((t) => ({ ...t, asset: 'btc' as const }));
      setTradesByStrategy((p) => ({
        ...p,
        [BLK_STRATEGY_ID]: [...enriched.reverse(), ...(p[BLK_STRATEGY_ID] ?? [])],
      }));
    }
  }, [btcPrice, btcTime, liveMode]);

  const fetchPrice = useCallback(async () => {
    try {
      const res = await fetch('/api/solana-bot/price');
      const json = await res.json();
      if (json.success && json.data?.price != null) {
        setPrice(json.data.price);
        setPriceTime(json.data.timestamp ?? Math.floor(Date.now() / 1000));
        setError(null);
      } else {
        setError(json.error || 'Failed to fetch price');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Price fetch failed');
    }
  }, []);

  const fetchOHLCV = useCallback(async () => {
    try {
      const results = await Promise.all(
        INSIDE_BAR_STRATEGIES.map(async (s) => {
          const res = await fetch(`/api/solana-bot/ohlcv?interval=${s.intervalSec}`);
          const json = await res.json();
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

  // Pattern detection when candles update (each strategy / bar size)
  useEffect(() => {
    setStateByStrategy((prev) => {
      let next = prev;
      let changed = false;
      for (const s of INSIDE_BAR_STRATEGIES) {
        const c = candlesByStrategy[s.id] ?? [];
        if (c.length < 4) continue;
        const st = prev[s.id];
        if (!st) continue;
        if (st.status !== 'idle' && st.status !== 'stopped' && st.status !== 'pattern_detected')
          continue;

        const setup = detectPattern(c, s.intervalSec);
        const sameCandleAlreadyTraded =
          setup != null &&
          st.lastTradedCandleUnixTime != null &&
          setup.candleUnixTime === st.lastTradedCandleUnixTime;

        // No longer a valid pattern, or same inside bar we already traded — drop stale "pattern detected"
        if (!setup || sameCandleAlreadyTraded) {
          if (st.status === 'pattern_detected') {
            if (!changed) {
              next = { ...prev };
              changed = true;
            }
            next[s.id] = {
              ...createInitialState(),
              lastTradedCandleUnixTime: st.lastTradedCandleUnixTime,
            };
          }
          continue;
        }

        const isDoubleInside =
          st.status === 'pattern_detected' &&
          st.setup &&
          st.setup.candleUnixTime !== setup.candleUnixTime;
        if (!changed) {
          next = { ...prev };
          changed = true;
        }
        next[s.id] = {
          ...createPatternDetectedState(setup),
          lastTradedCandleUnixTime: prev[s.id]?.lastTradedCandleUnixTime,
        };
        if (isDoubleInside) breakoutRef.current[s.id] = { long: 0, short: 0 };
      }
      return changed ? next : prev;
    });
  }, [candlesByStrategy]);

  // Price polling — fast if ANY strategy needs it
  useEffect(() => {
    if (useChartPrice) return;
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
  }, [stateByStrategy, fetchPrice, useChartPrice]);

  // Process price for all strategies (one mutable state copy per tick)
  useEffect(() => {
    if (price == null || priceTime == null) return;

    const positionSize = liveMode ? liveAmountToRun : paperPositionSizeUsd;
    const state = { ...stateByStrategyRef.current };
    const newTrades: Record<string, ClosedTrade[]> = {};

    const enrichList = (list: ClosedTrade[]): ClosedTrade[] =>
      list.map((closedTrade) => ({
        ...closedTrade,
        pnlUsd: (closedTrade.pnlPercent / 100) * positionSize,
        solAmount: positionSize / closedTrade.entryPrice,
      }));

    for (const s of INSIDE_BAR_STRATEGIES) {
      const sid = s.id;
      let st = state[sid];
      if (!st) continue;

      if (st.status === 'pattern_detected' && st.setup && !enteringRef.current[sid]) {
        const setup = st.setup;
        const longBreakout = isBreakoutLong(price, setup);
        const shortBreakout = isBreakoutShort(price, setup);
        const bc = breakoutRef.current[sid];

        if (longBreakout) {
          const prevLong = bc.long;
          bc.long += 1;
          bc.short = 0;
          if (prevLong >= 0) {
            enteringRef.current[sid] = true;
            bc.long = 0;
            bc.short = 0;
            st = enterLong(st, price, priceTime);
            state[sid] = st;
            if (liveMode && connected) void executeOnBreakout('long', price, sid);
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
            st = enterShort(st, price, priceTime);
            state[sid] = st;
            if (liveMode && connected) void executeOnBreakout('short', price, sid);
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
        const { newState, closedTrades } = checkPositionExit(st, price, priceTime);
        state[sid] = newState;
        if (closedTrades.length > 0) {
          newTrades[sid] = closedTrades;
        }
        continue;
      }

      if (st.status === 'reversed') {
        const { newState, closedTrades } = checkReversedExit(st, price, priceTime);
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
          const enriched = enrichList(newTrades[k]).reverse();
          n[k] = [...enriched, ...(prev[k] ?? [])];
        }
        return n;
      });
    }

    setBreakoutByStrategy(() => {
      const n: Record<string, { long: number; short: number }> = {};
      for (const s of INSIDE_BAR_STRATEGIES) {
        n[s.id] = { ...breakoutRef.current[s.id] };
      }
      return n;
    });
  }, [
    price,
    priceTime,
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
              <h1 className="text-2xl font-bold text-gray-900">SOL Trading Bot</h1>
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
              <span className="font-semibold">BLK</span> — on-chain transfer size (main output to Coinbase)
              sizes the session short; covers are {BLK_COVER_SLICES} equal BTC slices (on-chain BTC ÷{' '}
              {BLK_COVER_SLICES}, round-turn PnL per slice). Covers{' '}
              <span className="font-semibold">10:00–12:50 ET</span>. Pyth BTC price. Signals from{' '}
              <code className="text-xs bg-gray-100 px-1">/api/…/ibit/poll</code> (paper mode only).
            </>
          ) : (
            <>
              Viewing <span className="font-semibold">{intervalLabel(activeIntervalSec)}</span> bars ·
              Each tab keeps its own state, trade log, and performance ($
              {paperPositionSizeUsd.toFixed(0)} / strategy in paper mode).
            </>
          )}
        </p>
        {!isBlkTab && warmupMinutes > 0 && candles.length < 4 && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-amber-800 font-medium">Building candle data from Jupiter Perps</p>
            <p className="text-amber-700 text-sm mt-1">
              Price feed is live. First {intervalLabel(activeIntervalSec)} pattern available in ~
              {warmupMinutes} min (need 4 completed {intervalLabel(activeIntervalSec)} candles).
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
                      {blkPaperState.status === 'idle' ? 'idle (watching IBIT)' : 'short open (covering)'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">BTC (Pyth)</span>
                    <span className="font-mono font-medium">
                      {btcPrice != null ? `$${formatPrice(btcPrice)}` : '—'}
                    </span>
                  </div>
                  {blkPaperState.status === 'short_open' && blkPaperState.entryBtc != null && (
                    <>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Short entry</span>
                        <span className="font-mono">${formatPrice(blkPaperState.entryBtc)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">On-chain to CB (short size)</span>
                        <span className="font-mono">
                          {blkPaperState.chainMainOutBtc.toFixed(4)} BTC
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Per cover slice (BTC)</span>
                        <span className="font-mono">
                          {(blkPaperState.chainMainOutBtc / BLK_COVER_SLICES).toFixed(6)} BTC
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Ref. notional (short × Pyth)</span>
                        <span className="font-mono">
                          ${(blkPaperState.chainMainOutBtc * blkPaperState.entryBtc).toFixed(0)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600">Cover progress</span>
                        <span className="font-mono">
                          {blkPaperState.nextSliceIndex}/{BLK_COVER_SLICES} slices (10:00–12:50 ET)
                        </span>
                      </div>
                      {blkPaperState.signalTxid && (
                        <p className="text-xs text-gray-500 break-all">
                          Signal tx: {blkPaperState.signalTxid}
                        </p>
                      )}
                    </>
                  )}
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
                    <span className="text-gray-600">SOL Price (last candle)</span>
                    <span className="font-mono font-medium">
                      {candles.length > 0 ? `$${formatPrice(candles[0].close)}` : '—'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    Jupiter Perps — last {intervalLabel(activeIntervalSec)} close
                  </p>
                  <div className="flex justify-between">
                    <span className="text-gray-600">SOL Price (live)</span>
                    <span className="font-mono font-medium">
                      {price != null ? `$${formatPrice(price)}` : '—'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">
                    Jupiter Perps (Doves) — matches execution
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
                  ? 'Session open (chain-sized short) then 18 cover round-turns (short + buy per slice) with PnL each.'
                  : 'Entry: SOL amount @ price · time · Exit: price · time · PnL'}
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
                              ? `COVER ${t.blkSliceIndex != null ? t.blkSliceIndex + 1 : '?'}/${BLK_COVER_SLICES}`
                              : t.side?.toUpperCase()}
                        </span>
                        <span className="text-gray-500 text-xs">
                          {t.exitReason === 'blk_open'
                            ? 'short (chain size)'
                            : t.exitReason === 'blk_cover'
                              ? 'round-turn'
                              : t.exitReason}
                        </span>
                      </div>
                      <div className="grid gap-2">
                        {t.exitReason === 'blk_open' ? (
                          <>
                            <p className="text-gray-700">
                              Short <span className="font-mono">{t.btcAmount?.toFixed(4)} BTC</span> @{' '}
                              <span className="font-mono">${formatPrice(t.entryPrice)}</span>
                              <span className="text-gray-500 font-mono text-xs ml-2">
                                {formatTime(t.entryTime)}
                              </span>
                            </p>
                            <p className="text-xs text-gray-500">
                              Mirrors main output to Coinbase on the signal tx (on-chain size). PnL accrues on
                              cover rows below.
                            </p>
                          </>
                        ) : (
                          <>
                            <div className="flex flex-wrap gap-x-2">
                              <span className="text-gray-600 font-medium">Short leg:</span>
                              <span>
                                {t.asset === 'btc' && t.btcAmount != null
                                  ? `${t.btcAmount.toFixed(6)} BTC`
                                  : t.solAmount != null
                                    ? `${t.solAmount.toFixed(4)} SOL`
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
                        )}
                        {t.exitReason !== 'blk_open' && (
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
                    Built from Jupiter Perps (Doves oracle), polled every 15s. Jupiter&apos;s chart may use
                    different data/aggregation—small differences possible.
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
