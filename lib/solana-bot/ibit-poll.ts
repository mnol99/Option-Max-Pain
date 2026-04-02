import type { BlockstreamTxRef } from '@/lib/solana-bot/bitcoin-blockstream';
import {
  collectInputSourceAddresses,
  fetchAddressTxs,
  fetchTx,
  primaryInputSourceAddress,
  sumToAddresses,
  sumToAddress,
} from '@/lib/solana-bot/bitcoin-blockstream';
import { arkhamTxHash, fetchArkhamBitcoinTransfersForBase } from '@/lib/solana-bot/arkham-transfers';
import {
  getArkhamApiKey,
  getArkhamTimeLast,
  getArkhamTransferBase,
  getArkhamTransferLimit,
  getIbitCoinbaseAddressTxLimit,
  getIbitCoinbaseDestinationAddresses,
  getIbitDetectEndMinEt,
  getIbitDetectStartMinEt,
  getIbitExtraTxids,
  getIbitMainDepositAddress,
  getIbitMainOutMaxBtc,
  getIbitMainOutMinBtc,
  getIbitMinSats,
  getIbitWatchSourceAddresses,
  isArkhamIbitPollEnabled,
  isIbitAllowHistoricalBlockDay,
  getIbitSignalMaxAgeSec,
  isIbitPollSourceWatchAddresses,
  isIbitStrictFiltersEnabled,
} from '@/lib/solana-bot/ibit-config';
import {
  getCoverScheduleUtc,
  getEtDayStartUnix,
  getEtMinutesFromMidnight,
  IBIT_TZ,
  isBlockTimeInEtMinuteWindow,
  isWithinSignalWindowEt,
} from '@/lib/solana-bot/ibit-schedule';

export interface IbitTransferSignal {
  txid: string;
  /** Unix seconds (block time, or 0 if unknown) */
  blockTime: number;
  /**
   * Primary sender heuristic: address of the largest-value input prevout (feeder UTXO).
   * Use `inputSourceAddresses` for the full set.
   */
  sourceAddress: string;
  /** Distinct addresses that spent into this tx (prevouts) — pattern analysis / audit */
  inputSourceAddresses: string[];
  /** Any input address appears in the optional legacy custodian watch list */
  watchListMatch: boolean;
  /** coinbase_deposit | source_watch | extra_txid | arkham (Arkham GET /transfers → Blockstream validate) */
  signalSource: 'coinbase_deposit' | 'source_watch' | 'extra_txid' | 'arkham';
  /** When signalSource is arkham: `base` entity used in the API query */
  arkhamEntityBase?: string;
  /** Total sats to any watched Coinbase destination */
  sats: number;
  /** Sats to main Prime deposit address (large leg) */
  mainOutSats: number;
  /** mainOutSats / 1e8 */
  mainOutBtc: number;
  matchedDestinations: string[];
  coverScheduleUtc: string[];
  /** strict = time + main-output band; legacy = 02:00–09:30 ET */
  detectionMode: 'strict' | 'legacy';
}

export interface IbitBatchGroup {
  blockTime: number;
  txids: string[];
}

/**
 * Require tx block time to fall on **today's** ET calendar day so a 06:53 ET transfer from
 * months ago does not match every day (time-of-day alone is not enough).
 */
function blockTimeIsOnCurrentEtCalendarDay(blockTimeSec: number): boolean {
  const txDayStart = getEtDayStartUnix(new Date(blockTimeSec * 1000));
  const todayStart = getEtDayStartUnix(new Date());
  return txDayStart === todayStart;
}

/** Transfer must be recent (chain time), not just "today" — avoids replay after refresh on stale txs. */
function blockTimeWithinMaxSignalAge(blockTimeSec: number): boolean {
  if (isIbitAllowHistoricalBlockDay()) return true;
  const maxAge = getIbitSignalMaxAgeSec();
  if (maxAge <= 0) return true;
  const now = Math.floor(Date.now() / 1000);
  return blockTimeSec >= now - maxAge;
}

function blockTimePassesFilter(blockTimeSec: number): boolean {
  if (blockTimeSec <= 0) return false;
  if (!blockTimeWithinMaxSignalAge(blockTimeSec)) return false;
  const sameEtDayOk =
    isIbitAllowHistoricalBlockDay() || blockTimeIsOnCurrentEtCalendarDay(blockTimeSec);
  if (isIbitStrictFiltersEnabled()) {
    const inBatchWindow = isBlockTimeInEtMinuteWindow(
      blockTimeSec,
      getIbitDetectStartMinEt(),
      getIbitDetectEndMinEt()
    );
    /** Daytime (≥10:00 ET): afternoon cover schedule; still require main-output band elsewhere. */
    const m = getEtMinutesFromMidnight(new Date(blockTimeSec * 1000));
    const daytimeAfter10 = m >= 10 * 60;
    return sameEtDayOk && (inBatchWindow || daytimeAfter10);
  }
  const d = new Date(blockTimeSec * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IBIT_TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const minutes = hour * 60 + minute;
  return sameEtDayOk && minutes >= 2 * 60 && minutes < 9 * 60 + 30;
}

function mainOutputPassesStrictBand(mainOutSats: number): boolean {
  const minSats = Math.floor(getIbitMainOutMinBtc() * 1e8);
  if (mainOutSats < minSats) return false;
  const maxBtc = getIbitMainOutMaxBtc();
  if (maxBtc == null) return true;
  const maxSats = Math.ceil(maxBtc * 1e8);
  return mainOutSats <= maxSats;
}

function nowInActiveDetectWindow(): boolean {
  const now = new Date();
  if (isIbitStrictFiltersEnabled()) {
    const m = getEtMinutesFromMidnight(now);
    return m >= getIbitDetectStartMinEt() && m < getIbitDetectEndMinEt();
  }
  return isWithinSignalWindowEt(now);
}

export async function pollIbitTransfers(): Promise<{
  configured: boolean;
  watchAddresses: string[];
  coinbaseAddresses: string[];
  /** Broad 02:00–09:30 ET (legacy UI) */
  inLegacySignalWindow: boolean;
  /** Current time in active detection window (strict or legacy per config) */
  inDetectWindow: boolean;
  /** True when also polling legacy source watch addresses (env IBIT_POLL_SOURCE_WATCH=1) */
  pollSourceWatchAddresses: boolean;
  /** Arkham Intel: outgoing BTC for `base` → tx hashes → Blockstream validate */
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
    /** null = no upper cap */
    mainOutMaxBtc: number | null;
    coinbaseTxLimit: number;
    /** Block time must be within this many seconds of now (0 = disabled). */
    signalMaxAgeSec: number;
  };
  signals: IbitTransferSignal[];
  /** Same block_time → batch (multiple sends at once) */
  batchGroups: IbitBatchGroup[];
  error?: string;
}> {
  const watchAddresses = getIbitWatchSourceAddresses();
  const watchSet = new Set(watchAddresses);
  const coinbaseAddresses = getIbitCoinbaseDestinationAddresses();
  const minSats = getIbitMinSats();
  const destSet = new Set(coinbaseAddresses);
  const mainDeposit = getIbitMainDepositAddress();
  const strict = isIbitStrictFiltersEnabled();
  const pollWatch = isIbitPollSourceWatchAddresses();
  const coinbaseTxLimit = getIbitCoinbaseAddressTxLimit();

  if (coinbaseAddresses.length === 0) {
    return {
      configured: false,
      watchAddresses,
      coinbaseAddresses,
      inLegacySignalWindow: isWithinSignalWindowEt(),
      inDetectWindow: nowInActiveDetectWindow(),
      pollSourceWatchAddresses: pollWatch,
      arkham: {
        configured: !!getArkhamApiKey(),
        transferBase: getArkhamTransferBase(),
        timeLast: getArkhamTimeLast(),
      },
      detection: {
        strictFilters: strict,
        mainDepositAddress: mainDeposit,
        detectStartMinEt: getIbitDetectStartMinEt(),
        detectEndMinEt: getIbitDetectEndMinEt(),
        mainOutMinBtc: getIbitMainOutMinBtc(),
        mainOutMaxBtc: getIbitMainOutMaxBtc(),
        coinbaseTxLimit,
        signalMaxAgeSec: getIbitSignalMaxAgeSec(),
      },
      signals: [],
      batchGroups: [],
    };
  }

  const signals: IbitTransferSignal[] = [];
  const seen = new Set<string>();

  const buildSignal = (
    tx: BlockstreamTxRef,
    signalSource: IbitTransferSignal['signalSource'],
    arkhamEntityBase?: string
  ): IbitTransferSignal | null => {
    if (seen.has(tx.txid)) return null;
    const { sats, destinations } = sumToAddresses(tx, destSet);
    if (sats < minSats) return null;

    const mainOutSats = sumToAddress(tx, mainDeposit);
    const mainOutBtc = mainOutSats / 1e8;

    const blockTime = tx.status?.block_time ?? 0;
    const mode: 'strict' | 'legacy' = strict ? 'strict' : 'legacy';

    if (strict) {
      if (blockTime <= 0 || !blockTimePassesFilter(blockTime)) return null;
      if (!mainOutputPassesStrictBand(mainOutSats)) return null;
    } else {
      if (blockTime > 0 && !blockTimePassesFilter(blockTime)) return null;
    }

    seen.add(tx.txid);
    const anchor = blockTime > 0 ? new Date(blockTime * 1000) : new Date();
    const coverScheduleUtc = getCoverScheduleUtc(anchor).map((d) => d.toISOString());

    const inputSourceAddresses = collectInputSourceAddresses(tx);
    const primary = primaryInputSourceAddress(tx);
    const watchListMatch = inputSourceAddresses.some((a) => watchSet.has(a));
    const sourceAddress =
      primary ??
      inputSourceAddresses[0] ??
      (signalSource === 'extra_txid' ? 'extra-txid' : signalSource === 'arkham' ? 'arkham' : 'unknown');

    const out: IbitTransferSignal = {
      txid: tx.txid,
      blockTime,
      sourceAddress,
      inputSourceAddresses,
      watchListMatch,
      signalSource,
      sats,
      mainOutSats,
      mainOutBtc,
      matchedDestinations: Array.from(new Set(destinations)),
      coverScheduleUtc,
      detectionMode: mode,
    };
    if (arkhamEntityBase) out.arkhamEntityBase = arkhamEntityBase;
    return out;
  };

  const processTx = (
    tx: BlockstreamTxRef,
    signalSource: IbitTransferSignal['signalSource'],
    arkhamEntityBase?: string
  ): void => {
    const sig = buildSignal(tx, signalSource, arkhamEntityBase);
    if (sig) signals.push(sig);
  };

  /** 1) Manual / Arkham txids */
  for (const extraTxid of getIbitExtraTxids()) {
    try {
      const tx = await fetchTx(extraTxid);
      if (tx) processTx(tx, 'extra_txid');
    } catch {
      /* ignore */
    }
  }

  let arkhamMeta: { configured: boolean; transferBase: string; timeLast: string; error?: string } = {
    configured: false,
    transferBase: getArkhamTransferBase(),
    timeLast: getArkhamTimeLast(),
  };

  /** 1b) Arkham Intel API — entity `base` outgoing BTC, then validate full tx on Blockstream */
  const arkhamKey = getArkhamApiKey();
  if (isArkhamIbitPollEnabled() && arkhamKey) {
    arkhamMeta.configured = true;
    const transferBase = getArkhamTransferBase();
    arkhamMeta.transferBase = transferBase;
    arkhamMeta.timeLast = getArkhamTimeLast();
    const { transfers, error: arkErr } = await fetchArkhamBitcoinTransfersForBase({
      apiKey: arkhamKey,
      transferBase,
      limit: getArkhamTransferLimit(),
      timeLast: getArkhamTimeLast(),
    });
    if (arkErr) arkhamMeta.error = arkErr;
    const seenArkhamHashes = new Set<string>();
    for (const at of transfers) {
      const h = arkhamTxHash(at);
      if (!h || seenArkhamHashes.has(h)) continue;
      seenArkhamHashes.add(h);
      try {
        const tx = await fetchTx(h);
        if (tx) processTx(tx, 'arkham', transferBase);
      } catch {
        /* ignore */
      }
    }
  }

  /** 2) Coinbase deposit addresses first — large BTC in to main deposit → signal (sender = inputs) */
  for (const addr of coinbaseAddresses) {
    let txs: BlockstreamTxRef[];
    try {
      txs = await fetchAddressTxs(addr, coinbaseTxLimit);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        configured: true,
        watchAddresses,
        coinbaseAddresses,
        inLegacySignalWindow: isWithinSignalWindowEt(),
        inDetectWindow: nowInActiveDetectWindow(),
        pollSourceWatchAddresses: pollWatch,
        detection: {
          strictFilters: strict,
          mainDepositAddress: mainDeposit,
          detectStartMinEt: getIbitDetectStartMinEt(),
          detectEndMinEt: getIbitDetectEndMinEt(),
          mainOutMinBtc: getIbitMainOutMinBtc(),
          mainOutMaxBtc: getIbitMainOutMaxBtc(),
          coinbaseTxLimit,
          signalMaxAgeSec: getIbitSignalMaxAgeSec(),
        },
        signals: [],
        batchGroups: [],
        error: msg,
      };
    }

    for (const tx of txs) {
      processTx(tx, 'coinbase_deposit');
    }
  }

  /** 3) Optional: legacy path — txs spending from known custodian addresses */
  if (pollWatch) {
    for (const addr of watchAddresses) {
      let txs: BlockstreamTxRef[];
      try {
        txs = await fetchAddressTxs(addr, 30);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          configured: true,
          watchAddresses,
          coinbaseAddresses,
          inLegacySignalWindow: isWithinSignalWindowEt(),
          inDetectWindow: nowInActiveDetectWindow(),
          pollSourceWatchAddresses: pollWatch,
          detection: {
            strictFilters: strict,
            mainDepositAddress: mainDeposit,
            detectStartMinEt: getIbitDetectStartMinEt(),
            detectEndMinEt: getIbitDetectEndMinEt(),
            mainOutMinBtc: getIbitMainOutMinBtc(),
            mainOutMaxBtc: getIbitMainOutMaxBtc(),
            coinbaseTxLimit,
            signalMaxAgeSec: getIbitSignalMaxAgeSec(),
          },
          signals: [],
          batchGroups: [],
          error: msg,
        };
      }

      for (const tx of txs) {
        processTx(tx, 'source_watch');
      }
    }
  }

  signals.sort((a, b) => b.blockTime - a.blockTime);

  const byBlock = new Map<number, string[]>();
  for (const s of signals) {
    if (s.blockTime <= 0) continue;
    const list = byBlock.get(s.blockTime) ?? [];
    list.push(s.txid);
    byBlock.set(s.blockTime, list);
  }
  const batchGroups: IbitBatchGroup[] = Array.from(byBlock.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([blockTime, txids]) => ({ blockTime, txids }));

  return {
    configured: true,
    watchAddresses,
    coinbaseAddresses,
    inLegacySignalWindow: isWithinSignalWindowEt(),
    inDetectWindow: nowInActiveDetectWindow(),
    pollSourceWatchAddresses: pollWatch,
    arkham: arkhamMeta,
    detection: {
      strictFilters: strict,
      mainDepositAddress: mainDeposit,
      detectStartMinEt: getIbitDetectStartMinEt(),
      detectEndMinEt: getIbitDetectEndMinEt(),
      mainOutMinBtc: getIbitMainOutMinBtc(),
      mainOutMaxBtc: getIbitMainOutMaxBtc(),
      coinbaseTxLimit,
      signalMaxAgeSec: getIbitSignalMaxAgeSec(),
    },
    signals,
    batchGroups,
  };
}
