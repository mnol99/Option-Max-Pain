'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import dynamic from 'next/dynamic';
import { VersionedTransaction } from '@solana/web3.js';
import { getCoverScheduleUtc, IBIT_TZ } from '@/lib/solana-bot/ibit-schedule';

const WalletMultiButtonDynamic = dynamic(
  () => import('@solana/wallet-adapter-react-ui').then((m) => m.WalletMultiButton),
  { ssr: false }
);

const COVER_SLOTS = 25;
const POLL_MS = 60_000;
const PRICE_MS = 10_000;

interface PollPayload {
  configured: boolean;
  watchAddresses: string[];
  coinbaseAddresses: string[];
  inLegacySignalWindow: boolean;
  inDetectWindow: boolean;
  pollSourceWatchAddresses?: boolean;
  arkham?: {
    configured: boolean;
    transferBase: string;
    timeLast: string;
    error?: string;
  };
  detection: {
    strictFilters: boolean;
    mainDepositAddress: string;
    detectStartMinEt: number;
    detectEndMinEt: number;
    mainOutMinBtc: number;
    mainOutMaxBtc: number | null;
    coinbaseTxLimit?: number;
    signalMaxAgeSec?: number;
  };
  signals: Array<{
    txid: string;
    blockTime: number;
    sourceAddress: string;
    inputSourceAddresses?: string[];
    watchListMatch?: boolean;
    signalSource?: 'coinbase_deposit' | 'source_watch' | 'extra_txid' | 'arkham';
    arkhamEntityBase?: string;
    sats: number;
    mainOutSats?: number;
    mainOutBtc?: number;
    matchedDestinations: string[];
    coverScheduleUtc: string[];
    detectionMode?: 'strict' | 'legacy';
  }>;
  batchGroups: Array<{ blockTime: number; txids: string[] }>;
  error?: string;
}

function formatEt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    timeZone: IBIT_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatEtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export default function IbitPage() {
  const { publicKey, connected, wallet } = useWallet();
  const { connection } = useConnection();
  const [mounted, setMounted] = useState(false);
  const [poll, setPoll] = useState<PollPayload | null>(null);
  const [btcPrice, setBtcPrice] = useState<number | null>(null);
  const [liveMode, setLiveMode] = useState(false);
  const [liveAmountUsd, setLiveAmountUsd] = useState(1000);
  const [leverage, setLeverage] = useState(1.5);
  const [execError, setExecError] = useState<string | null>(null);

  const [shortActive, setShortActive] = useState(false);
  const [entryNotionalUsd, setEntryNotionalUsd] = useState(0);
  const [coveredSlots, setCoveredSlots] = useState(0);
  const [signalTxid, setSignalTxid] = useState<string | null>(null);
  const [manualScheduleAnchor, setManualScheduleAnchor] = useState<Date | null>(null);
  const coverTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const processedSignalsRef = useRef<Set<string>>(new Set());
  const scheduledTxRef = useRef<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchPoll = useCallback(async () => {
    try {
      const res = await fetch('/api/solana-bot/ibit/poll');
      const json = await res.json();
      if (json.success && json.data) setPoll(json.data);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchBtc = useCallback(async () => {
    try {
      const res = await fetch('/api/solana-bot/price?asset=btc');
      const json = await res.json();
      if (json.success && json.data?.price != null) setBtcPrice(json.data.price);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchPoll();
    const id = setInterval(fetchPoll, POLL_MS);
    return () => clearInterval(id);
  }, [fetchPoll]);

  useEffect(() => {
    fetchBtc();
    const id = setInterval(fetchBtc, PRICE_MS);
    return () => clearInterval(id);
  }, [fetchBtc]);

  const executeBtc = useCallback(
    async (side: 'long' | 'short', sizeUsd: number) => {
      if (!publicKey || !wallet?.adapter) return;
      setExecError(null);
      const btc = btcPrice;
      if (!btc || btc <= 0) {
        setExecError('BTC price not loaded');
        return;
      }
      try {
        const res = await fetch('/api/solana-bot/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            side,
            owner: publicKey.toString(),
            sizeUsd,
            leverage,
            asset: 'btc',
            btcPrice: btc,
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
    [publicKey, wallet, connection, leverage, btcPrice]
  );

  /** New on-chain signals → optional auto short (live only, once per txid). */
  useEffect(() => {
    if (!poll?.configured || !poll.signals?.length) return;
    for (const s of poll.signals) {
      if (processedSignalsRef.current.has(s.txid)) continue;
      processedSignalsRef.current.add(s.txid);
      if (liveMode && connected && s.blockTime > 0) {
        void executeBtc('short', liveAmountUsd).then(() => {
          setShortActive(true);
          setEntryNotionalUsd(liveAmountUsd);
          setCoveredSlots(0);
          setSignalTxid(s.txid);
        });
      } else if (!liveMode) {
        setShortActive(true);
        setEntryNotionalUsd(liveAmountUsd);
        setCoveredSlots(0);
        setSignalTxid(s.txid);
      }
    }
  }, [poll, liveMode, connected, liveAmountUsd, executeBtc]);

  const coverScheduleForActive = useMemo(() => {
    if (!signalTxid) return null;
    if (signalTxid === 'manual' && manualScheduleAnchor) {
      return getCoverScheduleUtc(manualScheduleAnchor).map((d) => d.toISOString());
    }
    const sig = poll?.signals?.find((x) => x.txid === signalTxid);
    return sig?.coverScheduleUtc?.length ? sig.coverScheduleUtc : null;
  }, [signalTxid, manualScheduleAnchor, poll]);

  /** Schedule 25 cover slices once per signal (paper = simulate; live = Jupiter longs). */
  useEffect(() => {
    if (!shortActive || !signalTxid) return;
    if (scheduledTxRef.current === signalTxid) return;

    const scheduleUtc = coverScheduleForActive;
    if (!scheduleUtc?.length) return;

    for (const t of coverTimersRef.current) clearTimeout(t);
    coverTimersRef.current = [];
    scheduledTxRef.current = signalTxid;

    const slice = entryNotionalUsd / COVER_SLOTS;
    const now = Date.now();

    const bumpCover = () => {
      setCoveredSlots((c) => {
        const next = Math.min(COVER_SLOTS, c + 1);
        if (next >= COVER_SLOTS) {
          setShortActive(false);
          setSignalTxid(null);
          scheduledTxRef.current = null;
        }
        return next;
      });
    };

    scheduleUtc.forEach((iso) => {
      const at = new Date(iso).getTime();
      const delay = Math.max(0, at - now);
      const timer = setTimeout(() => {
        if (liveMode) {
          void executeBtc('long', slice).then(bumpCover);
        } else {
          bumpCover();
        }
      }, delay);
      coverTimersRef.current.push(timer);
    });

    return () => {
      for (const t of coverTimersRef.current) clearTimeout(t);
      coverTimersRef.current = [];
    };
  }, [
    shortActive,
    signalTxid,
    liveMode,
    entryNotionalUsd,
    executeBtc,
    coverScheduleForActive,
  ]);

  const nextCoverLabel = useMemo(() => {
    const sched = coverScheduleForActive;
    if (!sched || coveredSlots >= COVER_SLOTS) return '—';
    return formatEt(sched[coveredSlots]!);
  }, [coverScheduleForActive, coveredSlots]);

  const detectWindowOpen =
    mounted && (poll?.inDetectWindow ?? false);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="container mx-auto px-4 py-4 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-bold text-gray-900">IBIT → Coinbase (BTC)</h1>
          <div className="flex items-center gap-3 flex-wrap">
            {connected && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-600">Mode:</span>
                <button
                  type="button"
                  onClick={() => setLiveMode(false)}
                  className={`px-3 py-1 rounded font-medium ${
                    !liveMode ? 'bg-primary-600 text-white' : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  Paper
                </button>
                <button
                  type="button"
                  onClick={() => setLiveMode(true)}
                  className={`px-3 py-1 rounded font-medium ${
                    liveMode ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-700'
                  }`}
                >
                  Live
                </button>
              </div>
            )}
            {mounted && <WalletMultiButtonDynamic />}
            <nav className="flex gap-2 text-sm">
              <Link href="/trade" className="text-gray-600 hover:text-gray-900">
                SOL bot
              </Link>
              <span className="text-gray-400">|</span>
              <span className="font-medium text-primary-600">IBIT</span>
            </nav>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 max-w-4xl space-y-6">
        <p className="text-sm text-gray-600">
          Monitors Bitcoin on-chain transfers from configured source addresses to your Coinbase Prime
          deposit addresses (Blockstream). By default, strict detection uses your sample:{' '}
          <strong>~06:00–07:45 ET</strong> block time, main output to the primary deposit in{' '}
          <strong>≥ ~200 BTC</strong> to the main deposit (no upper cap by default), and same
          addresses as before. Multiple txs in the same
          block are grouped as one batch. On signal: short BTC perps; cover in{' '}
          <strong>25 slices 11:00–14:00 ET</strong>. Override via{' '}
          <code className="text-xs bg-gray-100 px-1 rounded">.env.local</code> (
          <code className="text-xs">IBIT_DETECT_*</code>,{' '}
          <code className="text-xs">IBIT_MAIN_OUT_*</code>; set{' '}
          <code className="text-xs">IBIT_DISABLE_STRICT_FILTERS=1</code> for legacy 02:00–09:30 ET
          only).
        </p>

        <section className="bg-white rounded-lg shadow p-6 space-y-3">
          <h2 className="text-lg font-semibold">Status</h2>
          <div className="text-sm space-y-1">
            <p>
              BTC (Pyth):{' '}
              <span className="font-mono">{btcPrice != null ? `$${btcPrice.toFixed(2)}` : '—'}</span>
            </p>
            <p>
              Detection window (current time):{' '}
              <span className={detectWindowOpen ? 'text-green-700 font-medium' : 'text-gray-600'}>
                {mounted ? (detectWindowOpen ? 'open' : 'closed') : '…'}
              </span>
            </p>
            {poll?.detection && (
              <p className="text-xs text-gray-600">
                {poll.detection.strictFilters ? (
                  <>
                    Strict: block time ET {formatEtMin(poll.detection.detectStartMinEt)}–
                    {formatEtMin(poll.detection.detectEndMinEt)}; main out ≥{' '}
                    {poll.detection.mainOutMinBtc} BTC
                    {poll.detection.mainOutMaxBtc != null
                      ? `, ≤ ${poll.detection.mainOutMaxBtc} BTC`
                      : ' (no max)'}{' '}
                    to{' '}
                    <span className="font-mono">{poll.detection.mainDepositAddress.slice(0, 12)}…</span>
                  </>
                ) : (
                  <>Legacy: block time 02:00–09:30 ET (no main-output band)</>
                )}
              </p>
            )}
            <p className="text-xs text-gray-500">
              Legacy broad window (02:00–09:30 ET) now:{' '}
              {poll?.inLegacySignalWindow ? 'open' : 'closed'}
            </p>
            <p>
              API configured:{' '}
              <span className={poll?.configured ? 'text-green-700' : 'text-amber-700'}>
                {poll == null ? '…' : poll.configured ? 'yes' : 'no — set env addresses'}
              </span>
            </p>
            {poll?.error && <p className="text-red-600">Error: {poll.error}</p>}
          </div>
        </section>

        <section className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-semibold">Execution</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Notional ($)</label>
              <input
                type="number"
                min={1}
                value={liveAmountUsd}
                onChange={(e) => setLiveAmountUsd(Number(e.target.value) || 1000)}
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Leverage</label>
              <input
                type="number"
                min={1}
                max={100}
                step={0.1}
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value) || 1.5)}
                className="w-full border rounded px-3 py-2 text-sm"
              />
            </div>
          </div>
          <p className="text-xs text-gray-500">
            Short uses USDC collateral; each cover slice is a long BTC perp for{' '}
            {(liveAmountUsd / COVER_SLOTS).toFixed(2)} USD notional (1/{COVER_SLOTS} of entry).
            Long legs require <strong>WBTC</strong> in the wallet (mint{' '}
            <code className="text-[10px]">3NZ9…qmJh</code>)—fund the ATA or the cover txs can fail.
          </p>
          {execError && <p className="text-sm text-red-600">{execError}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!connected || !liveMode}
              onClick={() => {
                if (shortActive) return;
                scheduledTxRef.current = null;
                void executeBtc('short', liveAmountUsd).then(() => {
                  setShortActive(true);
                  setEntryNotionalUsd(liveAmountUsd);
                  setCoveredSlots(0);
                  setSignalTxid('manual');
                  setManualScheduleAnchor(new Date());
                });
              }}
              className="px-4 py-2 bg-red-600 text-white rounded text-sm font-medium disabled:opacity-50"
            >
              Manual short BTC
            </button>
            <button
              type="button"
              disabled={!connected || !liveMode || !shortActive}
              onClick={() => {
                const slice = entryNotionalUsd / COVER_SLOTS;
                void executeBtc('long', slice).then(() =>
                  setCoveredSlots((c) => {
                    const next = Math.min(COVER_SLOTS, c + 1);
                    if (next >= COVER_SLOTS) {
                      setShortActive(false);
                      setSignalTxid(null);
                      scheduledTxRef.current = null;
                    }
                    return next;
                  })
                );
              }}
              className="px-4 py-2 bg-green-600 text-white rounded text-sm font-medium disabled:opacity-50"
            >
              Manual cover slice
            </button>
            <button
              type="button"
              disabled={liveMode || shortActive}
              onClick={() => {
                scheduledTxRef.current = null;
                setShortActive(true);
                setEntryNotionalUsd(liveAmountUsd);
                setCoveredSlots(0);
                setSignalTxid('manual');
                setManualScheduleAnchor(new Date());
              }}
              className="px-4 py-2 bg-slate-600 text-white rounded text-sm font-medium disabled:opacity-50"
            >
              Simulate session (paper)
            </button>
          </div>
        </section>

        <section className="bg-white rounded-lg shadow p-6 space-y-3">
          <h2 className="text-lg font-semibold">Cover schedule</h2>
          {shortActive && signalTxid ? (
            <p className="text-sm">
              Covered {coveredSlots}/{COVER_SLOTS}. Next scheduled (ET):{' '}
              <span className="font-mono">{nextCoverLabel}</span>
            </p>
          ) : (
            <p className="text-sm text-gray-600">No active IBIT short from this session.</p>
          )}
          <p className="text-xs text-gray-500">
            Schedule uses 25 slots from 11:00 to 14:00 ET on the day of the transfer (anchor = block
            time). Example slots: {getCoverScheduleUtc(new Date()).slice(0, 3).map((d) => formatEt(d.toISOString())).join(', ')}
            …
          </p>
        </section>

        <section className="bg-white rounded-lg shadow p-6 space-y-4">
          <h2 className="text-lg font-semibold">Recent signals</h2>
          <p className="text-xs text-gray-600">
            Primary path: monitor <strong>Coinbase deposit</strong> addresses for large (~200+ BTC) transfers
            to the main output; sender addresses come from tx inputs. With{' '}
            <code className="bg-gray-100 px-1">ARKHAM_API_KEY</code>, Arkham{' '}
            <code className="bg-gray-100 px-1">GET /transfers</code> (entity <code className="bg-gray-100 px-1">base</code>,
            Bitcoin out) supplies tx hashes; each tx is validated on Blockstream. Optional{' '}
            <code className="bg-gray-100 px-1">IBIT_POLL_SOURCE_WATCH=1</code> also polls legacy custodian
            source addresses.
          </p>
          {poll?.arkham?.configured && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              Arkham: base=<span className="font-mono">{poll.arkham.transferBase}</span>, window=
              <span className="font-mono">{poll.arkham.timeLast}</span>
              {poll.arkham.error ? ` — error: ${poll.arkham.error}` : ''}
            </p>
          )}
          {poll?.batchGroups && poll.batchGroups.length > 0 && (
            <div className="text-sm">
              <p className="font-medium text-gray-800 mb-1">Same-block batches</p>
              <ul className="text-xs text-gray-600 space-y-1">
                {poll.batchGroups.slice(0, 8).map((b) => (
                  <li key={b.blockTime}>
                    {new Date(b.blockTime * 1000).toLocaleString('en-US', { timeZone: IBIT_TZ })} —{' '}
                    {b.txids.length} tx{b.txids.length > 1 ? 's' : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!poll?.signals?.length ? (
            <p className="text-sm text-gray-600">No matching transfers in the polled history.</p>
          ) : (
            <ul className="text-sm space-y-3 font-mono">
              {poll.signals.map((s) => (
                <li key={s.txid} className="border-b border-gray-100 pb-2">
                  <div>{s.txid}</div>
                  <div className="text-gray-600 text-xs">
                    main {s.mainOutBtc != null ? `${s.mainOutBtc.toFixed(4)} BTC` : '—'} · total{' '}
                    {s.sats} sats → {s.matchedDestinations.join(', ')}
                    {s.detectionMode && ` · ${s.detectionMode}`}
                    {s.signalSource && ` · ${s.signalSource}`}
                    {s.watchListMatch ? ' · watch-list match' : ''}
                  </div>
                  {(s.inputSourceAddresses?.length ?? 0) > 0 && (
                    <div className="text-gray-500 text-xs mt-1 break-all">
                      inputs: {s.inputSourceAddresses!.join(', ')}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-sm text-slate-700">
          <p className="font-semibold mb-2">Environment</p>
          <ul className="list-disc pl-5 space-y-1 text-xs">
            <li>
              <code>IBIT_BTC_WATCH_ADDRESSES</code> — optional legacy custodian sources (used for overlap
              audit; not required for signals when polling Coinbase first)
            </li>
            <li>
              <code>IBIT_BTC_COINBASE_ADDRESSES</code> — comma-separated destination addresses (e.g.
              Coinbase deposit) — polled first for large incoming transfers
            </li>
            <li>
              <code>IBIT_COINBASE_TX_LIMIT</code> — recent txs per Coinbase address (default 50, max 100)
            </li>
            <li>
              <code>IBIT_POLL_SOURCE_WATCH=1</code> — also poll legacy source watch addresses (default off)
            </li>
            <li>
              <code>ARKHAM_API_KEY</code> — Arkham Intel API key (header <code>API-Key</code>); never commit
            </li>
            <li>
              <code>ARKHAM_TRANSFER_BASE</code> — entity slug for <code>GET /transfers?base=</code> (default{' '}
              <code>blackrock</code> — confirm in Arkham UI)
            </li>
            <li>
              <code>ARKHAM_TIME_LAST</code> — e.g. <code>24h</code>, <code>7d</code> (default <code>7d</code>)
            </li>
            <li>
              <code>ARKHAM_TRANSFER_LIMIT</code> — rows per poll (default 25, max 50)
            </li>
            <li>
              <code>ARKHAM_DISABLE_IBIT_POLL=1</code> — skip Arkham even if key is set
            </li>
            <li>
              <code>IBIT_MIN_SATS</code> — optional minimum transfer size (default 100000)
            </li>
            <li>
              <code>BITCOIN_API_BASE</code> — optional (default Blockstream public API)
            </li>
            <li>
              <code>IBIT_DETECT_START_MIN_ET</code> / <code>IBIT_DETECT_END_MIN_ET</code> — minute of
              day ET (default 360–465 = 06:00–07:45)
            </li>
            <li>
              <code>IBIT_MAIN_OUT_MIN_BTC</code> — minimum main deposit BTC (default 200); optional{' '}
              <code>IBIT_MAIN_OUT_MAX_BTC</code> to cap (omit = no max, e.g. 600 or 2700 passes)
            </li>
            <li>
              <code>IBIT_MAIN_DEPOSIT_ADDRESS</code> — override primary deposit for the size band
            </li>
            <li>
              <code>IBIT_DISABLE_STRICT_FILTERS=1</code> — legacy 02:00–09:30 ET block filter only
            </li>
          </ul>
        </section>
      </main>
    </div>
  );
}
