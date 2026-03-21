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
} from '@/lib/solana-bot/trade-state';
import type { TradeState, ClosedTrade, OHLCVCandle } from '@/lib/solana-bot/types';

const PRICE_POLL_MS = 2000;   // When pattern detected or in position
const OHLCV_POLL_MS = 60000; // Check for new candles every minute
const PRICE_POLL_IDLE_MS = 10000; // When idle, poll less often

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

export default function TradePage() {
  const { publicKey, connected, wallet } = useWallet();
  const { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  const [state, setState] = useState<TradeState>(createInitialState());
  const [price, setPrice] = useState<number | null>(null);
  const [priceTime, setPriceTime] = useState<number | null>(null);
  const [candles, setCandles] = useState<OHLCVCandle[]>([]);
  const [trades, setTrades] = useState<ClosedTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [warmupMinutes, setWarmupMinutes] = useState<number>(0);
  const [liveMode, setLiveMode] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [paperStartingBalance, setPaperStartingBalance] = useState(1000);
  const [paperPositionSizeUsd, setPaperPositionSizeUsd] = useState(1000);
  const [liveAmountToRun, setLiveAmountToRun] = useState(1000);
  const [leverage, setLeverage] = useState(1.5);
  const [useChartPrice, setUseChartPrice] = useState(false);
  const lastCandleCheck = useRef(0);

  const executeOnBreakout = useCallback(
    async (side: 'long' | 'short', solPrice: number) => {
      if (!publicKey || !wallet?.adapter) return;
      setExecError(null);
      try {
        const res = await fetch('/api/solana-bot/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side,
          owner: publicKey.toString(),
          sizeUsd: liveAmountToRun,
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
      const res = await fetch('/api/solana-bot/ohlcv');
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        const newCandles = json.data;
        setCandles(newCandles);
        setWarmupMinutes(json.warmupMinutes ?? 0);
        setError(null);
        lastCandleCheck.current = Date.now();
        if (useChartPrice && newCandles.length > 0) {
          setPrice(newCandles[0].close);
          setPriceTime(Math.floor(Date.now() / 1000));
        }
      } else {
        setError(json.error || 'Failed to fetch OHLCV');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'OHLCV fetch failed');
    }
  }, [useChartPrice]);

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

  // Pattern detection when candles update
  useEffect(() => {
    if (candles.length < 4 || state.status !== 'idle' && state.status !== 'stopped') return;
    const setup = detectPattern(candles);
    if (setup) {
      setState(createPatternDetectedState(setup));
    }
  }, [candles]);

  // Price polling - faster when in trade or pattern detected (skip when using chart price)
  useEffect(() => {
    if (useChartPrice) return;
    const ms =
      state.status === 'pattern_detected' || state.status === 'in_position' || state.status === 'reversed'
        ? PRICE_POLL_MS
        : PRICE_POLL_IDLE_MS;
    fetchPrice();
    const id = setInterval(fetchPrice, ms);
    return () => clearInterval(id);
  }, [state.status, fetchPrice, useChartPrice]);

  // Process price when we have it
  useEffect(() => {
    if (price == null || priceTime == null) return;

    if (state.status === 'pattern_detected' && state.setup) {
      const setup = state.setup;
      if (isBreakoutLong(price, setup)) {
        setState((s) => enterLong(s, price, priceTime));
        if (liveMode && connected) executeOnBreakout('long', price);
        return;
      }
      if (isBreakoutShort(price, setup)) {
        setState((s) => enterShort(s, price, priceTime));
        if (liveMode && connected) executeOnBreakout('short', price);
        return;
      }
    }

    if (state.status === 'in_position') {
      const { newState, closedTrade } = checkPositionExit(state, price, priceTime);
      setState(newState);
      if (closedTrade) {
        const positionSize = liveMode ? liveAmountToRun : paperPositionSizeUsd;
        const enriched: ClosedTrade = {
          ...closedTrade,
          pnlUsd: (closedTrade.pnlPercent / 100) * positionSize,
          solAmount: positionSize / closedTrade.entryPrice,
        };
        setTrades((t) => [enriched, ...t]);
      }
      return;
    }

    if (state.status === 'reversed') {
      const { newState, closedTrade } = checkReversedExit(state, price, priceTime);
      setState(newState);
      if (closedTrade) {
        const positionSize = liveMode ? liveAmountToRun : paperPositionSizeUsd;
        const enriched: ClosedTrade = {
          ...closedTrade,
          pnlUsd: (closedTrade.pnlPercent / 100) * positionSize,
          solAmount: positionSize / closedTrade.entryPrice,
        };
        setTrades((t) => [enriched, ...t]);
      }
      return;
    }

    // When stopped, we stay stopped until next pattern is detected (from candles)
  }, [price, priceTime, state, liveMode, connected, executeOnBreakout, paperPositionSizeUsd, liveAmountToRun, leverage]);

  const metrics = computeMetrics(trades);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
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
              </nav>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {warmupMinutes > 0 && candles.length < 4 && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-amber-800 font-medium">Building candle data from Jupiter Perps</p>
            <p className="text-amber-700 text-sm mt-1">
              Price feed is live. First pattern available in ~{warmupMinutes} min (need 4 completed 5m candles).
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
                      ${(paperStartingBalance + metrics.totalPnl).toFixed(2)}
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
                  Jupiter Perps — last 5m close
                </p>
                <div className="flex justify-between">
                  <span className="text-gray-600">SOL Price (live)</span>
                  <span className="font-mono font-medium">
                    {price != null ? `$${formatPrice(price)}` : '—'}
                  </span>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={useChartPrice}
                    onChange={(e) => setUseChartPrice(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm text-gray-600">
                    Use chart price for breakouts (last 5m close)
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
            </section>

            {state.setup && (
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
                    <span className="text-gray-600">TP Long</span>
                    <span className="text-green-600">${formatPrice(state.setup.tpLong)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">TP Short</span>
                    <span className="text-red-600">${formatPrice(state.setup.tpShort)}</span>
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
              </div>
            </section>

            <section className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Trade Log</h2>
              <div className="max-h-80 overflow-y-auto space-y-3">
                {trades.length === 0 ? (
                  <p className="text-gray-500 text-sm">No closed trades yet</p>
                ) : (
                  trades.map((t) => (
                    <div
                      key={t.id}
                      className="p-3 border border-gray-200 rounded-lg text-sm space-y-2"
                    >
                      <div className="flex justify-between items-center">
                        <span
                          className={`font-medium ${
                            t.side === 'long' ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {t.side?.toUpperCase()}
                        </span>
                        <span className="text-gray-500 text-xs">{t.exitReason}</span>
                      </div>
                      <div className="space-y-1 text-gray-700">
                        <div>
                          <span className="text-gray-500">Entry:</span>{' '}
                          {t.solAmount != null
                            ? `${t.solAmount.toFixed(4)} SOL`
                            : '—'}
                          {' @ $'}
                          <span className="font-mono">{formatPrice(t.entryPrice)}</span>
                          {t.entryTime != null && (
                            <>
                              {' · '}
                              <span className="text-gray-500 text-xs">{formatTime(t.entryTime)}</span>
                            </>
                          )}
                        </div>
                        <div>
                          <span className="text-gray-500">Liquidation:</span>{' '}
                          <span className="font-mono">${formatPrice(t.liquidationPrice ?? t.exitPrice)}</span>
                          {' · '}
                          <span className="text-gray-500 text-xs">{formatTime(t.exitTime)}</span>
                        </div>
                      </div>
                      <div
                        className={`font-mono font-medium pt-1 ${
                          t.pnl >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        PnL:{' '}
                        {t.pnlUsd != null
                          ? `${t.pnlUsd >= 0 ? '+' : ''}$${t.pnlUsd.toFixed(2)}`
                          : `${t.pnl >= 0 ? '+' : ''}$${formatPrice(t.pnl)}`}
                        {' '}({t.pnlPercent >= 0 ? '+' : ''}{t.pnlPercent.toFixed(2)}%)
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Candles</h2>
              <p className="text-xs text-gray-500 mb-2">Built from Jupiter Perps (Doves oracle) price feed</p>
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
