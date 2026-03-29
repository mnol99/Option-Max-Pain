'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import dynamic from 'next/dynamic';
import { VersionedTransaction } from '@solana/web3.js';

const WalletMultiButton = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((m) => m.WalletMultiButton),
  { ssr: false }
);

type Pos = {
  asset: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  sizeUsd: number;
  stopPrice: number;
  tp1Price: number;
  tp2Vwap: number;
  tp1Done: boolean;
  entryBarUnix: number;
};

export default function MeanReversionPage() {
  const { publicKey, connected, wallet } = useWallet();
  const { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  const [tickData, setTickData] = useState<{
    positions: Record<string, Pos | null>;
    lastBar: Record<string, number | null>;
    completed15mBars?: Record<string, number>;
    minBarsForSignal?: number;
    logFile?: string;
    accountUsd?: number;
    positionSizeUsd?: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [execMsg, setExecMsg] = useState<string | null>(null);
  const executedRef = useRef<Set<string>>(new Set());

  useEffect(() => setMounted(true), []);

  const runTick = useCallback(async () => {
    try {
      const res = await fetch('/api/solana-bot/mean-reversion/tick');
      const json = await res.json();
      if (json.success && json.data) {
        setTickData(json.data);
        setError(null);
      } else {
        setError(json.error || 'tick failed');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'tick failed');
    }
  }, []);

  useEffect(() => {
    runTick();
    const id = setInterval(runTick, 60_000);
    return () => clearInterval(id);
  }, [runTick]);

  const executeMarket = useCallback(
    async (asset: 'sol' | 'btc', side: 'long' | 'short', sizeUsd: number) => {
      if (!publicKey || !wallet?.adapter) return;
      setExecMsg(null);
      try {
        let solPrice: number | undefined;
        let btcPrice: number | undefined;
        const pr = await fetch('/api/solana-bot/price');
        const pj = await pr.json();
        if (asset === 'sol' && pj.success && pj.data?.price) solPrice = pj.data.price;
        const br = await fetch('/api/solana-bot/price?asset=btc');
        const bj = await br.json();
        if (asset === 'btc' && bj.success && bj.data?.price) btcPrice = bj.data.price;

        const res = await fetch('/api/solana-bot/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            side,
            owner: publicKey.toString(),
            sizeUsd,
            leverage: 1.5,
            asset,
            solPrice: asset === 'sol' ? solPrice : undefined,
            btcPrice: asset === 'btc' ? btcPrice : undefined,
          }),
        });
        const json = await res.json();
        if (!json.success) {
          setExecMsg(json.error || 'Execute failed');
          return;
        }
        if (json.data?.serializedTx) {
          const tx = VersionedTransaction.deserialize(
            Buffer.from(json.data.serializedTx, 'base64')
          );
          const sig = await wallet.adapter.sendTransaction(tx, connection, { skipPreflight: false });
          await connection.confirmTransaction(sig);
          setExecMsg(`${asset.toUpperCase()} ${side} submitted`);
        }
      } catch (e) {
        setExecMsg(e instanceof Error ? e.message : 'Execute failed');
      }
    },
    [publicKey, wallet, connection]
  );

  useEffect(() => {
    if (!liveMode || !connected || !tickData?.positions) return;
    const size = tickData.positionSizeUsd ?? 200;
    for (const asset of ['sol', 'btc'] as const) {
      const p = tickData.positions[asset];
      if (!p) continue;
      const key = `${asset}-${p.entryBarUnix}-${p.entryTime}`;
      if (executedRef.current.has(key)) continue;
      executedRef.current.add(key);
      void executeMarket(asset, p.direction, size);
    }
  }, [liveMode, connected, tickData, executeMarket]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-4 flex flex-wrap justify-between items-center gap-4">
        <h1 className="text-xl font-bold text-gray-900">Mean reversion (Jupiter Perps)</h1>
        <div className="flex items-center gap-3">
          {connected && (
            <div className="flex gap-1 text-sm">
              <button
                type="button"
                onClick={() => setLiveMode(false)}
                className={`px-2 py-1 rounded ${!liveMode ? 'bg-primary-600 text-white' : 'bg-gray-100'}`}
              >
                Sim only
              </button>
              <button
                type="button"
                onClick={() => setLiveMode(true)}
                className={`px-2 py-1 rounded ${liveMode ? 'bg-green-600 text-white' : 'bg-gray-100'}`}
              >
                Live Jupiter
              </button>
            </div>
          )}
          {mounted && <WalletMultiButton />}
          <Link href="/trade" className="text-sm text-primary-600">
            Trade
          </Link>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 max-w-4xl space-y-6 text-sm">
        <p className="text-gray-600">
          15m mean-reversion (SOL + BTC), 1h trend filter. Server evaluates on each{' '}
          <strong>closed</strong> 15m bar; this page polls the server every <strong>60s</strong>.
          Candles are built from Doves (SOL) + Pyth (BTC) with synthetic volume. Set{' '}
          <code>MEAN_REV_ACCOUNT_USD</code> for 2% sizing. Logs:{' '}
          <code className="text-xs">{tickData?.logFile ?? 'data/mean-reversion-events.jsonl'}</code>
        </p>
        {tickData?.completed15mBars && tickData.minBarsForSignal != null && (
          <div
            className={`p-3 rounded-lg text-sm ${
              tickData.completed15mBars.sol! >= tickData.minBarsForSignal &&
              tickData.completed15mBars.btc! >= tickData.minBarsForSignal
                ? 'bg-green-50 text-green-900 border border-green-200'
                : 'bg-amber-50 text-amber-900 border border-amber-200'
            }`}
          >
            <strong>Status:</strong> Engine is running. SOL 15m bars stored:{' '}
            {tickData.completed15mBars.sol} / {tickData.minBarsForSignal} · BTC:{' '}
            {tickData.completed15mBars.btc} / {tickData.minBarsForSignal}. Entries need{' '}
            {tickData.minBarsForSignal} completed 15m bars per asset (~
            {Math.ceil((tickData.minBarsForSignal * 15) / 60)} hours of history after warm-up). If
            last bar is null, wait until the first 15m boundaries complete (~up to 30 min from dev
            server start).
          </div>
        )}

        {error && <div className="p-3 bg-red-50 text-red-800 rounded">{error}</div>}
        {execMsg && <div className="p-3 bg-amber-50 text-amber-900 rounded">{execMsg}</div>}

        <section className="bg-white rounded-lg shadow p-4">
          <h2 className="font-semibold mb-2">Account (sim sizing)</h2>
          <p>
            Balance assumption: ${tickData?.accountUsd?.toFixed(0) ?? '10000'} · Per trade 2%: $
            {tickData?.positionSizeUsd?.toFixed(2) ?? '—'}
          </p>
        </section>

        <section className="bg-white rounded-lg shadow p-4">
          <h2 className="font-semibold mb-2">Positions (server sim)</h2>
          {tickData?.positions ? (
            <div className="space-y-3 font-mono text-xs">
              {(['sol', 'btc'] as const).map((a) => {
                const p = tickData.positions[a];
                return (
                  <div key={a} className="border-b border-gray-100 pb-2">
                    <div className="font-bold text-gray-800">{a.toUpperCase()}</div>
                    {p ? (
                      <div className="grid gap-1 mt-1">
                        <span>
                          {p.direction} @ ${p.entryPrice.toFixed(4)} · SL ${p.stopPrice.toFixed(4)} · TP1{' '}
                          ${p.tp1Price.toFixed(4)} · TP2 VWAP ${p.tp2Vwap.toFixed(4)}
                        </span>
                        <span>TP1 done: {p.tp1Done ? 'yes' : 'no'}</span>
                      </div>
                    ) : (
                      <span className="text-gray-500">flat</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-gray-500">Loading…</p>
          )}
        </section>

        <section className="bg-white rounded-lg shadow p-4">
          <h2 className="font-semibold mb-2">Last closed 15m bar (unix)</h2>
          <p className="text-xs text-gray-500 mb-2">
            Shows the previous full 15m candle open time once at least two completed bars exist.
          </p>
          <pre className="text-xs overflow-x-auto">
            {JSON.stringify(tickData?.lastBar ?? {}, null, 2)}
          </pre>
        </section>

        <p className="text-xs text-gray-500">
          Live mode sends one market increase per new position when wallet is connected. Stops/TPs are
          simulated server-side (Jupiter resting stops not wired). Check logs for PnL.
        </p>
      </main>
    </div>
  );
}
