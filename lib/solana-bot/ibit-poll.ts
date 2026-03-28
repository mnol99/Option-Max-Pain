import { fetchAddressTxs, sumToAddresses, sumToAddress } from '@/lib/solana-bot/bitcoin-blockstream';
import {
  getIbitCoinbaseDestinationAddresses,
  getIbitDetectEndMinEt,
  getIbitDetectStartMinEt,
  getIbitMainDepositAddress,
  getIbitMainOutMaxBtc,
  getIbitMainOutMinBtc,
  getIbitMinSats,
  getIbitWatchSourceAddresses,
  isIbitStrictFiltersEnabled,
} from '@/lib/solana-bot/ibit-config';
import {
  getCoverScheduleUtc,
  getEtMinutesFromMidnight,
  IBIT_TZ,
  isBlockTimeInEtMinuteWindow,
  isWithinSignalWindowEt,
} from '@/lib/solana-bot/ibit-schedule';

export interface IbitTransferSignal {
  txid: string;
  /** Unix seconds (block time, or 0 if unknown) */
  blockTime: number;
  sourceAddress: string;
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

function blockTimePassesFilter(blockTimeSec: number): boolean {
  if (blockTimeSec <= 0) return false;
  if (isIbitStrictFiltersEnabled()) {
    return isBlockTimeInEtMinuteWindow(
      blockTimeSec,
      getIbitDetectStartMinEt(),
      getIbitDetectEndMinEt()
    );
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
  return minutes >= 2 * 60 && minutes < 9 * 60 + 30;
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
  detection: {
    strictFilters: boolean;
    mainDepositAddress: string;
    detectStartMinEt: number;
    detectEndMinEt: number;
    mainOutMinBtc: number;
    /** null = no upper cap */
    mainOutMaxBtc: number | null;
  };
  signals: IbitTransferSignal[];
  /** Same block_time → batch (multiple sends at once) */
  batchGroups: IbitBatchGroup[];
  error?: string;
}> {
  const watchAddresses = getIbitWatchSourceAddresses();
  const coinbaseAddresses = getIbitCoinbaseDestinationAddresses();
  const minSats = getIbitMinSats();
  const destSet = new Set(coinbaseAddresses);
  const mainDeposit = getIbitMainDepositAddress();
  const strict = isIbitStrictFiltersEnabled();

  if (watchAddresses.length === 0 || coinbaseAddresses.length === 0) {
    return {
      configured: false,
      watchAddresses,
      coinbaseAddresses,
      inLegacySignalWindow: isWithinSignalWindowEt(),
      inDetectWindow: nowInActiveDetectWindow(),
      detection: {
        strictFilters: strict,
        mainDepositAddress: mainDeposit,
        detectStartMinEt: getIbitDetectStartMinEt(),
        detectEndMinEt: getIbitDetectEndMinEt(),
        mainOutMinBtc: getIbitMainOutMinBtc(),
        mainOutMaxBtc: getIbitMainOutMaxBtc(),
      },
      signals: [],
      batchGroups: [],
    };
  }

  const signals: IbitTransferSignal[] = [];
  const seen = new Set<string>();

  for (const addr of watchAddresses) {
    let txs;
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
        detection: {
          strictFilters: strict,
          mainDepositAddress: mainDeposit,
          detectStartMinEt: getIbitDetectStartMinEt(),
          detectEndMinEt: getIbitDetectEndMinEt(),
          mainOutMinBtc: getIbitMainOutMinBtc(),
          mainOutMaxBtc: getIbitMainOutMaxBtc(),
        },
        signals: [],
        batchGroups: [],
        error: msg,
      };
    }

    for (const tx of txs) {
      if (seen.has(tx.txid)) continue;
      const { sats, destinations } = sumToAddresses(tx, destSet);
      if (sats < minSats) continue;

      const mainOutSats = sumToAddress(tx, mainDeposit);
      const mainOutBtc = mainOutSats / 1e8;

      const blockTime = tx.status?.block_time ?? 0;
      const mode: 'strict' | 'legacy' = strict ? 'strict' : 'legacy';

      if (strict) {
        if (blockTime <= 0 || !blockTimePassesFilter(blockTime)) continue;
        if (!mainOutputPassesStrictBand(mainOutSats)) continue;
      } else {
        if (blockTime > 0 && !blockTimePassesFilter(blockTime)) continue;
      }

      seen.add(tx.txid);
      const anchor = blockTime > 0 ? new Date(blockTime * 1000) : new Date();
      const coverScheduleUtc = getCoverScheduleUtc(anchor).map((d) => d.toISOString());

      signals.push({
        txid: tx.txid,
        blockTime,
        sourceAddress: addr,
        sats,
        mainOutSats,
        mainOutBtc,
        matchedDestinations: Array.from(new Set(destinations)),
        coverScheduleUtc,
        detectionMode: mode,
      });
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
    detection: {
      strictFilters: strict,
      mainDepositAddress: mainDeposit,
      detectStartMinEt: getIbitDetectStartMinEt(),
      detectEndMinEt: getIbitDetectEndMinEt(),
      mainOutMinBtc: getIbitMainOutMinBtc(),
      mainOutMaxBtc: getIbitMainOutMaxBtc(),
    },
    signals,
    batchGroups,
  };
}
