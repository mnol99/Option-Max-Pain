'use client';

import { useState, useEffect } from 'react';

function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function BacktestPage() {
  const [hours, setHours] = useState(6);
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runBacktest = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/solana-bot/backtest?hours=${hours}`);
      const json = await res.json();
      if (json.success) {
        setReport(json.data);
        if (json.data?.error) setError(json.data.error);
      } else {
        setError(json.error || 'Backtest failed');
        setReport(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runBacktest();
  }, []);

  const r = report as {
    hours?: number;
    startTime?: number;
    endTime?: number;
    totalCandles?: number;
    patternsDetected?: number;
    patternsWithBreakout?: number;
    patternsMissed?: number;
    tradeCount?: number;
    winCount?: number;
    lossCount?: number;
    winRate?: number;
    totalPnlPercent?: number;
    avgPnlPercent?: number;
    avgSlippageBps?: number;
    avgMaePercent?: number;
    avgMfePercent?: number;
    byExitReason?: Record<string, number>;
    trades?: Array<{
      side: string;
      entryPrice: number;
      exitPrice: number;
      exitReason: string;
      pnlPercent: number;
      slippageBps: number;
      maePercent: number;
      mfePercent: number;
    }>;
    detectedPatterns?: Array<{
      time: number;
      breakoutHigh: number;
      breakoutLow: number;
      triggeredLong: boolean;
      triggeredShort: boolean;
    }>;
  } | null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <h1 className="text-2xl font-bold text-gray-900">5-Minute Pattern Backtest</h1>
            <nav className="flex gap-2">
              <a href="/" className="text-sm text-gray-600 hover:text-gray-900">
                Option Max Pain
              </a>
              <span className="text-gray-400">|</span>
              <a href="/trade" className="text-sm text-gray-600 hover:text-gray-900">
                Trade
              </a>
              <span className="text-gray-400">|</span>
              <span className="text-sm font-medium text-primary-600">Backtest</span>
            </nav>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="mb-6 p-4 bg-white rounded-lg shadow flex items-center gap-4">
          <label className="text-sm text-gray-600">Hours to analyze:</label>
          <input
            type="number"
            min={1}
            max={24}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value) || 6)}
            className="w-20 px-2 py-1 border rounded"
          />
          <button
            type="button"
            onClick={runBacktest}
            disabled={loading}
            className="px-4 py-2 bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
          >
            {loading ? 'Running…' : 'Run Backtest'}
          </button>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800">
            {error}
          </div>
        )}

        {r && !r.error && (
          <div className="space-y-6">
            <section className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Period</h2>
              <p className="text-sm text-gray-600">
                {formatTime(r.startTime ?? 0)} — {formatTime(r.endTime ?? 0)} ({r.hours}h)
              </p>
              <p className="text-sm text-gray-500 mt-1">{r.totalCandles} candles</p>
            </section>

            <section className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Pattern Detection</h2>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Patterns detected</p>
                  <p className="text-xl font-bold">{r.patternsDetected}</p>
                </div>
                <div>
                  <p className="text-gray-500">With breakout (traded)</p>
                  <p className="text-xl font-bold">{r.patternsWithBreakout}</p>
                </div>
                <div>
                  <p className="text-gray-500">Missed (no breakout)</p>
                  <p className="text-xl font-bold">{r.patternsMissed}</p>
                </div>
              </div>
            </section>

            <section className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Performance</h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Trades</p>
                  <p className="text-xl font-bold">{r.tradeCount}</p>
                </div>
                <div>
                  <p className="text-gray-500">Win rate</p>
                  <p className="text-xl font-bold">{(r.winRate ?? 0).toFixed(1)}%</p>
                </div>
                <div>
                  <p className="text-gray-500">Total PnL %</p>
                  <p className={`text-xl font-bold ${(r.totalPnlPercent ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {(r.totalPnlPercent ?? 0) >= 0 ? '+' : ''}{(r.totalPnlPercent ?? 0).toFixed(2)}%
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Avg PnL %</p>
                  <p className={`text-xl font-bold ${(r.avgPnlPercent ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {(r.avgPnlPercent ?? 0) >= 0 ? '+' : ''}{(r.avgPnlPercent ?? 0).toFixed(2)}%
                  </p>
                </div>
              </div>
            </section>

            <section className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Slippage & Excursion</h2>
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-gray-500">Avg slippage (bps)</p>
                  <p className="text-xl font-bold">{(r.avgSlippageBps ?? 0).toFixed(1)}</p>
                  <p className="text-xs text-gray-400">Entry vs breakout level</p>
                </div>
                <div>
                  <p className="text-gray-500">Avg MAE %</p>
                  <p className="text-xl font-bold text-red-600">{(r.avgMaePercent ?? 0).toFixed(2)}%</p>
                  <p className="text-xs text-gray-400">Max drawdown during trade</p>
                </div>
                <div>
                  <p className="text-gray-500">Avg MFE %</p>
                  <p className="text-xl font-bold text-green-600">{(r.avgMfePercent ?? 0).toFixed(2)}%</p>
                  <p className="text-xs text-gray-400">Max profit before exit</p>
                </div>
              </div>
            </section>

            <section className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Exit Reasons</h2>
              <div className="flex gap-4 text-sm">
                {Object.entries(r.byExitReason ?? {}).map(([reason, count]) => (
                  <span key={reason} className="px-3 py-1 bg-gray-100 rounded">
                    {reason}: {count}
                  </span>
                ))}
              </div>
            </section>

            <section className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Trade Log</h2>
              <div className="overflow-x-auto max-h-96">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="py-2">Side</th>
                      <th className="py-2">Entry</th>
                      <th className="py-2">Exit</th>
                      <th className="py-2">Reason</th>
                      <th className="py-2">PnL %</th>
                      <th className="py-2">Slippage</th>
                      <th className="py-2">MAE</th>
                      <th className="py-2">MFE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r.trades ?? []).map((t, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className={`py-2 font-medium ${t.side === 'long' ? 'text-green-600' : 'text-red-600'}`}>
                          {t.side}
                        </td>
                        <td className="py-2 font-mono">{t.entryPrice.toFixed(2)}</td>
                        <td className="py-2 font-mono">{t.exitPrice.toFixed(2)}</td>
                        <td className="py-2">{t.exitReason}</td>
                        <td className={`py-2 font-mono ${t.pnlPercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {(t.pnlPercent >= 0 ? '+' : '') + t.pnlPercent.toFixed(2)}%
                        </td>
                        <td className="py-2 font-mono">{t.slippageBps.toFixed(1)} bps</td>
                        <td className="py-2 font-mono text-red-600">{t.maePercent.toFixed(2)}%</td>
                        <td className="py-2 font-mono text-green-600">{t.mfePercent.toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Detected Patterns</h2>
              <div className="overflow-x-auto max-h-64">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="py-2">Time</th>
                      <th className="py-2">High</th>
                      <th className="py-2">Low</th>
                      <th className="py-2">Long</th>
                      <th className="py-2">Short</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r.detectedPatterns ?? []).map((p, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="py-2 font-mono">{formatTime(p.time)}</td>
                        <td className="py-2 font-mono">{p.breakoutHigh.toFixed(2)}</td>
                        <td className="py-2 font-mono">{p.breakoutLow.toFixed(2)}</td>
                        <td className="py-2">{p.triggeredLong ? '✓' : '—'}</td>
                        <td className="py-2">{p.triggeredShort ? '✓' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        <p className="mt-8 text-center text-sm text-gray-500">
          Uses Birdeye historical OHLCV (BIRDEYE_API_KEY required). Simulates inside-bar + smallest-range
          pattern with breakout confirmation.
        </p>
      </main>
    </div>
  );
}
