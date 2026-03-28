import { fetchAddressTxs, sumToAddresses } from '@/lib/solana-bot/bitcoin-blockstream';
import {
  getIbitCoinbaseDestinationAddresses,
  getIbitMinSats,
  getIbitWatchSourceAddresses,
} from '@/lib/solana-bot/ibit-config';
import { getCoverScheduleUtc, IBIT_TZ, isWithinSignalWindowEt } from '@/lib/solana-bot/ibit-schedule';

export interface IbitTransferSignal {
  txid: string;
  /** Unix seconds (block time, or 0 if unknown) */
  blockTime: number;
  sourceAddress: string;
  sats: number;
  matchedDestinations: string[];
  coverScheduleUtc: string[];
}

function blockTimeInSignalWindowEt(blockTimeSec: number): boolean {
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

export async function pollIbitTransfers(): Promise<{
  configured: boolean;
  watchAddresses: string[];
  coinbaseAddresses: string[];
  inSignalWindow: boolean;
  signals: IbitTransferSignal[];
  error?: string;
}> {
  const watchAddresses = getIbitWatchSourceAddresses();
  const coinbaseAddresses = getIbitCoinbaseDestinationAddresses();
  const minSats = getIbitMinSats();
  const destSet = new Set(coinbaseAddresses);

  if (watchAddresses.length === 0 || coinbaseAddresses.length === 0) {
    return {
      configured: false,
      watchAddresses,
      coinbaseAddresses,
      inSignalWindow: isWithinSignalWindowEt(),
      signals: [],
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
        inSignalWindow: isWithinSignalWindowEt(),
        signals: [],
        error: msg,
      };
    }

    for (const tx of txs) {
      if (seen.has(tx.txid)) continue;
      const { sats, destinations } = sumToAddresses(tx, destSet);
      if (sats < minSats) continue;

      const blockTime = tx.status?.block_time ?? 0;
      if (blockTime > 0 && !blockTimeInSignalWindowEt(blockTime)) continue;

      seen.add(tx.txid);
      const anchor = blockTime > 0 ? new Date(blockTime * 1000) : new Date();
      const coverScheduleUtc = getCoverScheduleUtc(anchor).map((d) => d.toISOString());

      signals.push({
        txid: tx.txid,
        blockTime,
        sourceAddress: addr,
        sats,
        matchedDestinations: Array.from(new Set(destinations)),
        coverScheduleUtc,
      });
    }
  }

  signals.sort((a, b) => b.blockTime - a.blockTime);

  return {
    configured: true,
    watchAddresses,
    coinbaseAddresses,
    inSignalWindow: isWithinSignalWindowEt(),
    signals,
  };
}
