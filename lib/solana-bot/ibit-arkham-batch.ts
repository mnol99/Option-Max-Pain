/**
 * Arkham batch mode: 2nd ~300 BTC BR→Coinbase → short; 2nd ~300 BTC Coinbase→BR (after open) → long.
 */

import {
  fetchTx,
  sumFromAddressAsInput,
  sumToAddress,
} from '@/lib/solana-bot/bitcoin-blockstream';
import { arkhamTxHash, fetchArkhamBitcoinTransfersForBase } from '@/lib/solana-bot/arkham-transfers';
import {
  getArkhamApiKey,
  getArkhamBatchTargetBtc,
  getArkhamBatchToleranceBtc,
  getArkhamCounterpartySlug,
  getArkhamLongAfterMinEt,
  getArkhamTimeLast,
  getArkhamTransferBase,
  getArkhamTransferLimit,
  getIbitMainDepositAddress,
} from '@/lib/solana-bot/ibit-config';
import {
  getBlkLongCoverScheduleUtc,
  getCoverScheduleUtc,
  getEtDayKey,
  IBIT_TZ,
  isBeforeBlkLongBuyTriggerWindowEt,
} from '@/lib/solana-bot/ibit-schedule';
import type { IbitTransferSignal } from '@/lib/solana-bot/ibit-types';
import {
  getArkhamBatchDayState,
  saveArkhamBatchDayState,
  type DayPayload,
} from '@/lib/solana-bot/arkham-batch-state';

const ARKHAM_REQ_GAP_MS = 1100;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function inBatchBand(btc: number, target: number, tol: number): boolean {
  return btc >= target - tol && btc <= target + tol;
}

function blockTimeAfterOpenEt(blockTimeSec: number, minEt: number): boolean {
  const d = new Date(blockTimeSec * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: IBIT_TZ,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const m = hour * 60 + minute;
  return m >= minEt;
}

async function blockTimeForTx(h: string): Promise<number> {
  const tx = await fetchTx(h);
  return tx?.status?.block_time ?? 0;
}

function sortHashesByBlockTimeAsc(hashes: string[], times: Map<string, number>): string[] {
  return [...hashes].sort((a, b) => (times.get(a) ?? 0) - (times.get(b) ?? 0));
}

function buildSignal(
  tx: NonNullable<Awaited<ReturnType<typeof fetchTx>>>,
  role: 'second_out_short' | 'second_in_long',
  mainDeposit: string,
  arkhamBase: string
): IbitTransferSignal {
  const blockTime = tx.status?.block_time ?? 0;
  const mainOutSats =
    role === 'second_out_short'
      ? sumToAddress(tx, mainDeposit)
      : sumFromAddressAsInput(tx, mainDeposit);
  const mainOutBtc = mainOutSats / 1e8;
  const anchor = blockTime > 0 ? new Date(blockTime * 1000) : new Date();
  const coverScheduleUtc =
    role === 'second_in_long'
      ? getBlkLongCoverScheduleUtc(anchor).map((d) => d.toISOString())
      : getCoverScheduleUtc(anchor).map((d) => d.toISOString());

  return {
    txid: tx.txid,
    blockTime,
    sourceAddress: role === 'second_out_short' ? 'arkham-batch-out' : 'arkham-batch-in',
    inputSourceAddresses: [],
    watchListMatch: false,
    signalSource: 'arkham',
    arkhamEntityBase: arkhamBase,
    sats: mainOutSats,
    mainOutSats,
    mainOutBtc,
    matchedDestinations: [mainDeposit],
    coverScheduleUtc,
    detectionMode: 'strict',
    blkArkhamBatchRole: role,
  };
}

/**
 * Merge Arkham rows with Blockstream validation; emit at most one short + one long signal per poll.
 */
export async function processArkhamBatchSignals(): Promise<{
  signals: IbitTransferSignal[];
  error?: string;
}> {
  const apiKey = getArkhamApiKey();
  if (!apiKey) return { signals: [] };

  const target = getArkhamBatchTargetBtc();
  const tol = getArkhamBatchToleranceBtc();
  const mainDeposit = getIbitMainDepositAddress();
  const transferBase = getArkhamTransferBase();
  const counterparty = getArkhamCounterpartySlug();
  const limit = getArkhamTransferLimit();
  const timeLast = getArkhamTimeLast();
  const longAfterMin = getArkhamLongAfterMinEt();

  const etDayKey = getEtDayKey(new Date());
  let day = getArkhamBatchDayState(etDayKey);

  const { transfers: outT, error: e1 } = await fetchArkhamBitcoinTransfersForBase({
    apiKey,
    transferBase,
    limit,
    timeLast,
    flow: 'out',
    counterparties: counterparty,
  });
  if (e1) return { signals: [], error: e1 };

  await sleep(ARKHAM_REQ_GAP_MS);

  const { transfers: inT, error: e2 } = await fetchArkhamBitcoinTransfersForBase({
    apiKey,
    transferBase,
    limit,
    timeLast,
    flow: 'in',
    counterparties: counterparty,
  });
  if (e2) return { signals: [], error: e2 };

  const timeMap = new Map<string, number>();
  const outSet = new Set(day.outHashes);
  const inSet = new Set(day.inHashes);

  for (const at of outT) {
    const h = arkhamTxHash(at);
    if (!h || outSet.has(h)) continue;
    const hint = typeof at.unitValue === 'number' ? at.unitValue : 0;
    if (!inBatchBand(hint, target, tol)) continue;
    const tx = await fetchTx(h);
    if (!tx) continue;
    const btc = sumToAddress(tx, mainDeposit) / 1e8;
    if (!inBatchBand(btc, target, tol)) continue;
    outSet.add(h);
    timeMap.set(h, tx.status?.block_time ?? 0);
  }

  await sleep(ARKHAM_REQ_GAP_MS);

  for (const at of inT) {
    const h = arkhamTxHash(at);
    if (!h || inSet.has(h)) continue;
    const hint = typeof at.unitValue === 'number' ? at.unitValue : 0;
    if (!inBatchBand(hint, target, tol)) continue;
    const tx = await fetchTx(h);
    if (!tx) continue;
    const btc = sumFromAddressAsInput(tx, mainDeposit) / 1e8;
    if (!inBatchBand(btc, target, tol)) continue;
    inSet.add(h);
    timeMap.set(h, tx.status?.block_time ?? 0);
  }

  for (const h of Array.from(outSet)) {
    if (!timeMap.has(h)) timeMap.set(h, await blockTimeForTx(h));
  }
  for (const h of Array.from(inSet)) {
    if (!timeMap.has(h)) timeMap.set(h, await blockTimeForTx(h));
  }

  const outOrdered = sortHashesByBlockTimeAsc(Array.from(outSet), timeMap);
  const inOrdered = sortHashesByBlockTimeAsc(Array.from(inSet), timeMap);

  const nextDay: DayPayload = {
    etDayKey,
    outHashes: outOrdered,
    inHashes: inOrdered,
    emittedSecondOutTxid: day.emittedSecondOutTxid,
    emittedSecondInTxid: day.emittedSecondInTxid,
  };

  const outSignals: IbitTransferSignal[] = [];

  if (outOrdered.length >= 2) {
    const second = outOrdered[1]!;
    if (nextDay.emittedSecondOutTxid !== second) {
      const tx = await fetchTx(second);
      if (tx) {
        outSignals.push(buildSignal(tx, 'second_out_short', mainDeposit, transferBase));
        nextDay.emittedSecondOutTxid = second;
      }
    }
  }

  if (inOrdered.length >= 2 && isBeforeBlkLongBuyTriggerWindowEt()) {
    const second = inOrdered[1]!;
    if (nextDay.emittedSecondInTxid !== second) {
      const tx = await fetchTx(second);
      const bt = tx?.status?.block_time ?? 0;
      if (tx && bt > 0 && blockTimeAfterOpenEt(bt, longAfterMin)) {
        outSignals.push(buildSignal(tx, 'second_in_long', mainDeposit, transferBase));
        nextDay.emittedSecondInTxid = second;
      }
    }
  }

  saveArkhamBatchDayState(nextDay);
  return { signals: outSignals };
}
