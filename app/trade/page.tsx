'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
  const [state, setState] = useState<TradeState>(createInitialState());
  const [price, setPrice] = useState<number | null>(null);
  const [priceTime, setPriceTime] = useState<number | null>(null);
  const [candles, setCandles] = useState<OHLCVCandle[]>([]);
  const [trades, setTrades] = useState<ClosedTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const lastCandleCheck = useRef(0);

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
        setCandles(json.data);
        setApiConfigured(true);
        setError(null);
        lastCandleCheck.current = Date.now();
      } else {
        if (json.error?.includes('BIRDEYE_API_KEY')) {
          setApiConfigured(false);
        }
        setError(json.error || 'Failed to fetch OHLCV');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'OHLCV fetch failed');
    }
  }, []);

  // Initial load and OHLCV polling
  useEffect(() => {
    fetchOHLCV();
    const ohlcvInterval = setInterval(fetchOHLCV, OHLCV_POLL_MS);
    return () => clearInterval(ohlcvInterval);
  }, [fetchOHLCV]);

  // Pattern detection when candles update
  useEffect(() => {
    if (candles.length < 4 || state.status !== 'idle' && state.status !== 'stopped') return;
    const setup = detectPattern(candles);
    if (setup) {
      setState(createPatternDetectedState(setup));
    }
  }, [candles]);

  // Price polling - faster when in trade or pattern detected
  useEffect(() => {
    if (apiConfigured === false) return;
    const ms =
      state.status === 'pattern_detected' || state.status === 'in_position' || state.status === 'reversed'
        ? PRICE_POLL_MS
        : PRICE_POLL_IDLE_MS;
    fetchPrice();
    const id = setInterval(fetchPrice, ms);
    return () => clearInterval(id);
  }, [apiConfigured, state.status, fetchPrice]);

  // Process price when we have it
  useEffect(() => {
    if (price == null || priceTime == null) return;

    if (state.status === 'pattern_detected' && state.setup) {
      const setup = state.setup;
      if (isBreakoutLong(price, setup)) {
        setState((s) => enterLong(s, price, priceTime));
        return;
      }
      if (isBreakoutShort(price, setup)) {
        setState((s) => enterShort(s, price, priceTime));
        return;
      }
    }

    if (state.status === 'in_position') {
      const { newState, closedTrade } = checkPositionExit(state, price, priceTime);
      setState(newState);
      if (closedTrade) setTrades((t) => [closedTrade, ...t]);
      return;
    }

    if (state.status === 'reversed') {
      const { newState, closedTrade } = checkReversedExit(state, price, priceTime);
      setState(newState);
      if (closedTrade) setTrades((t) => [closedTrade, ...t]);
      return;
    }

    // When stopped, we stay stopped until next pattern is detected (from candles)
  }, [price, priceTime, state]);

  const metrics = computeMetrics(trades);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold text-gray-900">SOL Trading Bot</h1>
            <nav className="flex gap-4">
              <a href="/" className="text-sm text-gray-600 hover:text-gray-900">
                Option Max Pain
              </a>
              <span className="text-sm text-gray-400">|</span>
              <span className="text-sm font-medium text-primary-600">Trade</span>
            </nav>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {apiConfigured === false && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-amber-800 font-medium">Birdeye API key required</p>
            <p className="text-amber-700 text-sm mt-1">
              Add <code className="bg-amber-100 px-1 rounded">BIRDEYE_API_KEY</code> to{' '}
              <code className="bg-amber-100 px-1 rounded">.env.local</code> and restart the dev server.
              Get a key at{' '}
              <a
                href="https://birdeye.so"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                birdeye.so
              </a>
              .
            </p>
          </div>
        )}

        {error && apiConfigured !== false && (
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
                  <span className="text-gray-600">SOL Price</span>
                  <span className="font-mono font-medium">
                    {price != null ? `$${formatPrice(price)}` : '—'}
                  </span>
                </div>
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
              <div className="max-h-64 overflow-y-auto space-y-2">
                {trades.length === 0 ? (
                  <p className="text-gray-500 text-sm">No closed trades yet</p>
                ) : (
                  trades.map((t) => (
                    <div
                      key={t.id}
                      className="flex justify-between items-center py-2 border-b border-gray-100 last:border-0"
                    >
                      <div>
                        <span
                          className={`font-medium ${
                            t.side === 'long' ? 'text-green-600' : 'text-red-600'
                          }`}
                        >
                          {t.side?.toUpperCase()}
                        </span>
                        <span className="text-gray-500 text-sm ml-2">
                          {t.exitReason} @ ${formatPrice(t.exitPrice)}
                        </span>
                      </div>
                      <span
                        className={`font-mono ${
                          t.pnl >= 0 ? 'text-green-600' : 'text-red-600'
                        }`}
                      >
                        {t.pnl >= 0 ? '+' : ''}${formatPrice(t.pnl)} ({t.pnlPercent >= 0 ? '+' : ''}
                        {t.pnlPercent.toFixed(2)}%)
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="bg-white rounded-lg shadow-md p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Candles</h2>
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
          Phase 1: Pattern detection + paper trading. Execution (Jupiter Perps + Solflare) coming
          next.
        </p>
      </main>
    </div>
  );
}
