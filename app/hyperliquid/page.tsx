'use client';

import { useCallback, useEffect, useState } from 'react';
import { parseApiJson } from '@/lib/solana-bot/parse-api-json';

type Dashboard = {
  hasKey: boolean;
  user: string | null;
  testnet: boolean;
  envHourlyEnabled: boolean;
  envHourlyCancelPriorBands?: boolean;
  config: {
    coin: string;
    collateralUsd: number;
    leverage: number;
    afterMinute: number;
    notionalUsd: number;
  };
  hourly: {
    enabled: boolean;
    runEnabled?: boolean;
    lastPlacedHourStartMs: number | null;
    lastRefHigh: string | null;
    lastRefLow: string | null;
    lastBuyOid: number | null;
    lastSellOid: number | null;
    lastPlacedAtMs: number | null;
    lastError: string | null;
  };
  openOrders: Array<{ coin: string; side: string; limitPx: string; sz: string; oid: number }>;
  recentFills: Array<{
    coin: string;
    side: string;
    px: string;
    sz: string;
    time: number;
    closedPnl: string;
    fee: string;
  }>;
  margin?: { accountValue: string; withdrawable: string; totalNtlPos: string };
  error?: string;
};

export default function HyperliquidPage() {
  const [d, setD] = useState<Dashboard | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    coin: 'SOL',
    collateralUsd: 50,
    leverage: 2,
    afterMinute: 1,
    enabled: false,
  });

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch('/api/hyperliquid');
      const j = await parseApiJson<{
        success?: boolean;
        data?: Dashboard;
        error?: string;
      }>(res);
      if (!j.success || !j.data) {
        setErr(j.error || 'load failed');
        return;
      }
      setD(j.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'fetch failed');
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/hyperliquid/config');
      const j = await parseApiJson<{
        success?: boolean;
        data?: {
          coin?: string;
          collateralUsd?: number;
          leverage?: number;
          afterMinute?: number;
          enabled?: boolean;
          envHourlyEnabled?: boolean;
        };
      }>(res);
      if (j.success && j.data) {
        const c = j.data;
        if (c.coin) setForm((f) => ({ ...f, coin: c.coin! }));
        if (c.collateralUsd != null) setForm((f) => ({ ...f, collateralUsd: c.collateralUsd! }));
        if (c.leverage != null) setForm((f) => ({ ...f, leverage: c.leverage! }));
        if (c.afterMinute != null) setForm((f) => ({ ...f, afterMinute: c.afterMinute! }));
        if (c.enabled != null) setForm((f) => ({ ...f, enabled: c.enabled! }));
      }
    } catch {
      /* optional */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadConfig();
  }, [load, loadConfig]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch('/api/hyperliquid/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coin: form.coin,
          collateralUsd: form.collateralUsd,
          leverage: form.leverage,
          afterMinute: form.afterMinute,
          enabled: form.enabled,
        }),
      });
      const j = await parseApiJson<{ success?: boolean; error?: string }>(res);
      if (!j.success) setErr(j.error || 'Save failed');
      await loadConfig();
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const tick = async () => {
    setErr(null);
    try {
      const res = await fetch('/api/hyperliquid/tick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bypassMinuteGate: true }),
      });
      const j = await parseApiJson<{
        success?: boolean;
        result?: { ok?: boolean; error?: string; detail?: string; skipped?: string };
        error?: string;
      }>(res);
      if (!j.success) {
        setErr(j.error || 'Tick failed');
        return;
      }
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Tick failed');
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="max-w-4xl mx-auto">
        <header className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <h1 className="text-2xl font-bold text-slate-900">Hyperliquid — hourly limit bands</h1>
          <nav className="flex gap-2 text-sm">
            <a href="/trade" className="text-indigo-600 hover:underline">
              Trade (Solana)
            </a>
            <a href="/" className="text-slate-600 hover:underline">
              Home
            </a>
          </nav>
        </header>

        <p className="text-sm text-slate-600 mb-4">
          Each <strong>UTC</strong> hour, after the configured minute, the server sets leverage and places a{' '}
          <strong>buy</strong> limit at the <strong>previous hour&apos;s low</strong> and a <strong>sell</strong>{' '}
          limit at the <strong>previous hour&apos;s high</strong> (GTC). By default{' '}
          <strong>prior unrefilled band limits stay on the book</strong> until they fill or you cancel manually
          (hours can stack — watch margin). Set{' '}
          <code className="bg-slate-100 px-1">HL_HOURLY_CANCEL_PRIOR_BANDS=1</code> on the server to restore old
          behavior: cancel existing open limits for that coin before each new hourly pair. Notional ≈ collateral ×
          leverage. Requires <code className="bg-slate-100 px-1">HL_API_PRIVATE_KEY</code> (0x EVM) on the server —
          not Solana.
        </p>

        {err && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 text-sm rounded">{err}</div>
        )}

        {d && (
          <div className="space-y-4">
            <div className="p-4 bg-white border border-slate-200 rounded-lg shadow-sm">
              <h2 className="font-semibold text-slate-800 mb-2">Status</h2>
              <ul className="text-sm text-slate-700 space-y-1 font-mono">
                <li>EVM wallet (read/HL API): {d.hasKey && d.user ? d.user : 'no key'}</li>
                <li>Testnet: {d.testnet ? 'yes' : 'no'}</li>
                <li>Heartbeat active if: (HL_HOURLY_BANDS_ENABLED=1 OR Run enabled below)</li>
                <li>env HL_HOURLY_BANDS_ENABLED: {d.envHourlyEnabled ? '1' : '0'}</li>
                <li>
                  env HL_HOURLY_CANCEL_PRIOR_BANDS:{' '}
                  {d.envHourlyCancelPriorBands === true ? '1 (cancel before new bracket)' : '0 (keep working orders)'}
                </li>
                {d.margin && (
                  <>
                    <li>Account value: {d.margin.accountValue}</li>
                    <li>Withdrawable: {d.margin.withdrawable}</li>
                    <li>Notional pos: {d.margin.totalNtlPos}</li>
                  </>
                )}
                {d.error && <li className="text-amber-700">Info API: {d.error}</li>}
              </ul>
            </div>

            <div className="p-4 bg-white border border-slate-200 rounded-lg shadow-sm">
              <h2 className="font-semibold text-slate-800 mb-2">Last hourly placement (server state)</h2>
              <ul className="text-sm text-slate-700 space-y-1">
                <li>Last ref high: {d.hourly.lastRefHigh ?? '—'}</li>
                <li>Last ref low: {d.hourly.lastRefLow ?? '—'}</li>
                <li>Last run error: {d.hourly.lastError ?? '—'}</li>
              </ul>
            </div>

            <div className="p-4 bg-white border border-slate-200 rounded-lg shadow-sm">
              <h2 className="font-semibold text-slate-800 mb-3">Parameters (saved in .data/hl-ui-config.json)</h2>
              <div className="grid sm:grid-cols-2 gap-3 text-sm">
                <label className="block">
                  <span className="text-slate-600">Symbol (perp)</span>
                  <input
                    className="mt-1 w-full border border-slate-300 rounded px-2 py-1"
                    value={form.coin}
                    onChange={(e) => setForm((f) => ({ ...f, coin: e.target.value }))}
                  />
                </label>
                <label className="block">
                  <span className="text-slate-600">Collateral (USD margin)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    className="mt-1 w-full border border-slate-300 rounded px-2 py-1"
                    value={form.collateralUsd}
                    onChange={(e) => setForm((f) => ({ ...f, collateralUsd: Number(e.target.value) || 0 }))}
                  />
                </label>
                <label className="block">
                  <span className="text-slate-600">Leverage (×)</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    step={0.5}
                    className="mt-1 w-full border border-slate-300 rounded px-2 py-1"
                    value={form.leverage}
                    onChange={(e) => setForm((f) => ({ ...f, leverage: Number(e.target.value) || 1 }))}
                  />
                </label>
                <label className="block">
                  <span className="text-slate-600">Run after (UTC minute, 0–30)</span>
                  <input
                    type="number"
                    min={0}
                    max={30}
                    className="mt-1 w-full border border-slate-300 rounded px-2 py-1"
                    value={form.afterMinute}
                    onChange={(e) => setForm((f) => ({ ...f, afterMinute: Number(e.target.value) || 0 }))}
                  />
                </label>
                <label className="sm:col-span-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                  />
                  <span>
                    <strong>Run</strong> hourly bot (or set HL_HOURLY_BANDS_ENABLED=1 in .env and leave this off)
                  </span>
                </label>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                ≈ notional: ${(form.collateralUsd * form.leverage).toFixed(2)} (both legs use the same
                notional; margin must cover both in cross — reduce size or use isolated in HL UI if
                needed).
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className="px-3 py-1.5 bg-slate-800 text-white rounded text-sm disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save parameters'}
                </button>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="px-3 py-1.5 bg-slate-200 text-slate-800 rounded text-sm"
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => void tick()}
                  className="px-3 py-1.5 bg-amber-100 text-amber-900 border border-amber-300 rounded text-sm"
                >
                  Try tick now
                </button>
              </div>
            </div>

            <div className="p-4 bg-white border border-slate-200 rounded-lg shadow-sm">
              <h2 className="font-semibold text-slate-800 mb-2">Open limit orders (coin)</h2>
              {d.openOrders.length === 0 ? (
                <p className="text-sm text-slate-500">None</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-600">
                      <th className="py-1">Coin</th>
                      <th>Side</th>
                      <th>Price</th>
                      <th>Size</th>
                      <th>oid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.openOrders.map((o) => (
                      <tr key={o.oid} className="border-t border-slate-100">
                        <td className="py-1 font-mono">{o.coin}</td>
                        <td>{o.side}</td>
                        <td className="font-mono">{o.limitPx}</td>
                        <td className="font-mono">{o.sz}</td>
                        <td className="font-mono">{o.oid}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="p-4 bg-white border border-slate-200 rounded-lg shadow-sm">
              <h2 className="font-semibold text-slate-800 mb-2">Recent fills (all coins)</h2>
              {d.recentFills.length === 0 ? (
                <p className="text-sm text-slate-500">None in sample</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-600">
                        <th className="py-1">Time</th>
                        <th>Coin</th>
                        <th>Side</th>
                        <th>Px</th>
                        <th>Sz</th>
                        <th>Closed PnL</th>
                        <th>Fee</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.recentFills.map((f, i) => (
                        <tr key={`${f.time}-${i}`} className="border-t border-slate-100">
                          <td className="py-1 whitespace-nowrap">
                            {new Date(f.time).toISOString().replace('T', ' ').slice(0, 19)}
                          </td>
                          <td>{f.coin}</td>
                          <td>{f.side}</td>
                          <td className="font-mono">{f.px}</td>
                          <td className="font-mono">{f.sz}</td>
                          <td className="font-mono">{f.closedPnl}</td>
                          <td className="font-mono">{f.fee}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
