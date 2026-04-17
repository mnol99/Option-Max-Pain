/**
 * Arkham batch mode (entity base = BlackRock, counterparty = Coinbase):
 * - **Default pair rule:** 200+ BTC run-up (below tight ~300 band) then ~300 striker → short/long on striker tx.
 * - **Simple pair (`ARKHAM_BATCH_SIMPLE_PAIR=1`):** two consecutive transfers (Blockstream BTC ≥ min each)
 *   → **short** on 2nd BR→CB, **long** on 2nd CB→BR (long still needs block ≥9:30 ET, poll before 2pm ET wall).
 */

import {
  fetchTx,
  maxOutputSatsExcludingAddresses,
  sumFromAddressesAsInput,
  sumToAddress,
} from '@/lib/solana-bot/bitcoin-blockstream';
import { arkhamTxHash, fetchArkhamBitcoinTransfersForBase } from '@/lib/solana-bot/arkham-transfers';
import {
  getArkhamApiKey,
  getArkhamBatchCoinbaseSpendAddresses,
  getArkhamBatchPairMinBtc,
  getArkhamBatchRunMinBtc,
  getArkhamBatchStrikerToleranceBtc,
  getArkhamBatchTargetBtc,
  getArkhamBatchToleranceBtc,
  getArkhamCounterpartySlug,
  getArkhamLongAfterMinEt,
  getArkhamTimeLast,
  getArkhamTransferBase,
  getArkhamTransferLimit,
  getIbitExtraTxids,
  getIbitMainDepositAddress,
  isArkhamBatchSimplePairEnabled,
  isArkhamSecondStrikerLongEnabled,
} from '@/lib/solana-bot/ibit-config';
import {
  getBlkLongCoverScheduleUtc,
  getCoverScheduleUtc,
  getEtDayKey,
  IBIT_TZ,
  isBlkLongBuyAllowedForBlockTimeEt,
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

function inBand(btc: number, target: number, halfTol: number): boolean {
  return btc >= target - halfTol && btc <= target + halfTol;
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

type LegKind = 'striker' | 'runup';

function classifyBrToCb(
  tx: NonNullable<Awaited<ReturnType<typeof fetchTx>>>,
  mainDeposit: string,
  target: number,
  strikerTol: number,
  broadTol: number,
  runMin: number
): LegKind | null {
  const btc = sumToAddress(tx, mainDeposit) / 1e8;
  if (inBand(btc, target, strikerTol)) return 'striker';
  if (btc >= runMin && btc < target - strikerTol && btc <= target + broadTol) return 'runup';
  return null;
}

function classifyCbToBr(
  tx: NonNullable<Awaited<ReturnType<typeof fetchTx>>>,
  cbSpendExclude: Set<string>,
  target: number,
  strikerTol: number,
  broadTol: number,
  runMin: number
): LegKind | null {
  const btc = maxOutputSatsExcludingAddresses(tx, cbSpendExclude) / 1e8;
  if (inBand(btc, target, strikerTol)) return 'striker';
  if (btc >= runMin && btc < target - strikerTol && btc <= target + broadTol) return 'runup';
  return null;
}

function arkhamHintRelevant(
  hint: number,
  target: number,
  broadTol: number,
  strikerTol: number,
  runMin: number
): boolean {
  if (inBand(hint, target, broadTol)) return true;
  if (inBand(hint, target, strikerTol)) return true;
  if (hint >= runMin && hint < target + broadTol) return true;
  return false;
}

function arkhamHintRelevantSimple(hint: number, pairMinBtc: number): boolean {
  if (!Number.isFinite(hint) || hint <= 0) return false;
  return hint >= Math.max(50, pairMinBtc * 0.75);
}

/** Arkham may omit `unitValue` or send a string — coerce for pre-filter. */
function arkhamBtcHint(at: { unitValue?: unknown }): number {
  const v = at.unitValue;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

interface SimplePairRow {
  hash: string;
  blockTime: number;
  btc: number;
}

async function measureBrToCbBtc(
  h: string,
  mainDeposit: string
): Promise<{ row: SimplePairRow } | null> {
  const tx = await fetchTx(h);
  if (!tx) return null;
  const btc = sumToAddress(tx, mainDeposit) / 1e8;
  const bt = tx.status?.block_time ?? 0;
  return { row: { hash: h, blockTime: bt, btc } };
}

async function measureCbToBrBtc(
  h: string,
  cbSpendExclude: Set<string>
): Promise<{ row: SimplePairRow } | null> {
  const tx = await fetchTx(h);
  if (!tx) return null;
  const btc = maxOutputSatsExcludingAddresses(tx, cbSpendExclude) / 1e8;
  const bt = tx.status?.block_time ?? 0;
  return { row: { hash: h, blockTime: bt, btc } };
}

function buildSignal(
  tx: NonNullable<Awaited<ReturnType<typeof fetchTx>>>,
  role: 'second_out_short' | 'second_in_long' | 'second_striker_in_long',
  mainDeposit: string,
  arkhamBase: string,
  cbSpendSet: Set<string>
): IbitTransferSignal {
  const blockTime = tx.status?.block_time ?? 0;
  const mainOutSats =
    role === 'second_out_short'
      ? sumToAddress(tx, mainDeposit)
      : sumFromAddressesAsInput(tx, cbSpendSet);
  const mainOutBtc = mainOutSats / 1e8;
  const anchor = blockTime > 0 ? new Date(blockTime * 1000) : new Date();
  const isLongRole = role === 'second_in_long' || role === 'second_striker_in_long';
  const coverScheduleUtc = isLongRole
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

interface ClassifiedRow {
  hash: string;
  blockTime: number;
  kind: LegKind;
}

async function classifyOutHash(
  h: string,
  mainDeposit: string,
  target: number,
  strikerTol: number,
  broadTol: number,
  runMin: number
): Promise<ClassifiedRow | null> {
  const tx = await fetchTx(h);
  if (!tx) return null;
  const kind = classifyBrToCb(tx, mainDeposit, target, strikerTol, broadTol, runMin);
  if (!kind) return null;
  const bt = tx.status?.block_time ?? 0;
  return { hash: h, blockTime: bt, kind };
}

async function classifyInHash(
  h: string,
  cbSpendExclude: Set<string>,
  target: number,
  strikerTol: number,
  broadTol: number,
  runMin: number
): Promise<ClassifiedRow | null> {
  const tx = await fetchTx(h);
  if (!tx) return null;
  const kind = classifyCbToBr(tx, cbSpendExclude, target, strikerTol, broadTol, runMin);
  if (!kind) return null;
  const bt = tx.status?.block_time ?? 0;
  return { hash: h, blockTime: bt, kind };
}

/**
 * Merge Arkham rows with Blockstream validation; emit pair-based short/long on striker txids.
 */
export async function processArkhamBatchSignals(): Promise<{
  signals: IbitTransferSignal[];
  error?: string;
}> {
  const apiKey = getArkhamApiKey();
  if (!apiKey) return { signals: [] };

  const target = getArkhamBatchTargetBtc();
  const broadTol = getArkhamBatchToleranceBtc();
  const strikerTol = getArkhamBatchStrikerToleranceBtc();
  const runMin = getArkhamBatchRunMinBtc();
  const mainDeposit = getIbitMainDepositAddress();
  const cbSpendList = getArkhamBatchCoinbaseSpendAddresses();
  const cbSpendSet = new Set(cbSpendList);
  const transferBase = getArkhamTransferBase();
  const counterparty = getArkhamCounterpartySlug();
  const limit = getArkhamTransferLimit();
  const timeLast = getArkhamTimeLast();
  const longAfterMin = getArkhamLongAfterMinEt();
  const simplePair = isArkhamBatchSimplePairEnabled();
  const pairMinBtc = getArkhamBatchPairMinBtc();

  const etDayKey = getEtDayKey(new Date());
  const day = getArkhamBatchDayState(etDayKey);

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

  const outHashSet = new Set<string>(day.outHashes);
  const inHashSet = new Set<string>(day.inHashes);

  for (const at of outT) {
    const h = arkhamTxHash(at);
    if (!h) continue;
    const hint = arkhamBtcHint(at);
    const ok = simplePair
      ? hint <= 0 || arkhamHintRelevantSimple(hint, pairMinBtc)
      : arkhamHintRelevant(hint, target, broadTol, strikerTol, runMin);
    if (!ok) continue;
    outHashSet.add(h);
  }

  await sleep(ARKHAM_REQ_GAP_MS);

  for (const at of inT) {
    const h = arkhamTxHash(at);
    if (!h) continue;
    const hint = arkhamBtcHint(at);
    const ok = simplePair
      ? hint <= 0 || arkhamHintRelevantSimple(hint, pairMinBtc)
      : arkhamHintRelevant(hint, target, broadTol, strikerTol, runMin);
    if (!ok) continue;
    inHashSet.add(h);
  }

  /**
   * Arkham sometimes omits txs that still match on-chain (same block batch, labeling lag).
   * `IBIT_EXTRA_TXIDS` merges into batch sets after Blockstream validation.
   */
  for (const raw of getIbitExtraTxids()) {
    const h = raw.toLowerCase();
    if (outHashSet.has(h) || inHashSet.has(h)) continue;
    if (simplePair) {
      const mOut = await measureBrToCbBtc(h, mainDeposit);
      if (mOut && mOut.row.btc >= pairMinBtc) {
        outHashSet.add(h);
        continue;
      }
      const mIn = await measureCbToBrBtc(h, cbSpendSet);
      if (mIn && mIn.row.btc >= pairMinBtc) inHashSet.add(h);
    } else {
      const outRow = await classifyOutHash(h, mainDeposit, target, strikerTol, broadTol, runMin);
      if (outRow) {
        outHashSet.add(h);
        continue;
      }
      const inRow = await classifyInHash(h, cbSpendSet, target, strikerTol, broadTol, runMin);
      if (inRow) inHashSet.add(h);
    }
  }

  const outSignals: IbitTransferSignal[] = [];

  const nextDayBase: DayPayload = {
    etDayKey,
    outHashes: [],
    inHashes: [],
    emittedSecondOutTxid: day.emittedSecondOutTxid,
    emittedSecondInTxid: day.emittedSecondInTxid,
    emittedPairShortStrikerTxid: day.emittedPairShortStrikerTxid ?? null,
    emittedPairLongStrikerTxid: day.emittedPairLongStrikerTxid ?? null,
    emittedSecondStrikerInLongTxid: day.emittedSecondStrikerInLongTxid ?? null,
  };

  if (simplePair) {
    const outSimple: SimplePairRow[] = [];
    for (const h of Array.from(outHashSet)) {
      const m = await measureBrToCbBtc(h, mainDeposit);
      if (!m || m.row.btc < pairMinBtc) continue;
      let bt = m.row.blockTime;
      if (bt <= 0) bt = await blockTimeForTx(h);
      outSimple.push({ hash: h, blockTime: bt, btc: m.row.btc });
    }
    outSimple.sort((a, b) =>
      a.blockTime !== b.blockTime ? a.blockTime - b.blockTime : a.hash.localeCompare(b.hash)
    );

    const nextDay: DayPayload = {
      ...nextDayBase,
      outHashes: outSimple.map((r) => r.hash),
      inHashes: [],
    };

    for (let i = 1; i < outSimple.length; i++) {
      const prev = outSimple[i - 1]!;
      const cur = outSimple[i]!;
      if (prev.btc < pairMinBtc || cur.btc < pairMinBtc) continue;
      if (nextDay.emittedPairShortStrikerTxid === cur.hash) break;
      const tx = await fetchTx(cur.hash);
      if (!tx) continue;
      outSignals.push(buildSignal(tx, 'second_out_short', mainDeposit, transferBase, cbSpendSet));
      nextDay.emittedPairShortStrikerTxid = cur.hash;
      break;
    }

    const inSimple: SimplePairRow[] = [];
    for (const h of Array.from(inHashSet)) {
      const m = await measureCbToBrBtc(h, cbSpendSet);
      if (!m || m.row.btc < pairMinBtc) continue;
      let bt = m.row.blockTime;
      if (bt <= 0) bt = await blockTimeForTx(h);
      inSimple.push({ hash: h, blockTime: bt, btc: m.row.btc });
    }
    inSimple.sort((a, b) =>
      a.blockTime !== b.blockTime ? a.blockTime - b.blockTime : a.hash.localeCompare(b.hash)
    );

    nextDay.inHashes = inSimple.map((r) => r.hash);

    for (let i = 1; i < inSimple.length; i++) {
      const prev = inSimple[i - 1]!;
      const cur = inSimple[i]!;
      if (prev.btc < pairMinBtc || cur.btc < pairMinBtc) continue;
      if (nextDay.emittedPairLongStrikerTxid === cur.hash) break;
      const tx = await fetchTx(cur.hash);
      const bt = tx?.status?.block_time ?? 0;
      if (!tx || bt <= 0 || !blockTimeAfterOpenEt(bt, longAfterMin)) continue;
      if (!isBlkLongBuyAllowedForBlockTimeEt(bt)) continue;
      outSignals.push(buildSignal(tx, 'second_in_long', mainDeposit, transferBase, cbSpendSet));
      nextDay.emittedPairLongStrikerTxid = cur.hash;
      break;
    }

    saveArkhamBatchDayState(nextDay);
    return { signals: outSignals };
  }

  const outRows: ClassifiedRow[] = [];
  for (const h of Array.from(outHashSet)) {
    const row = await classifyOutHash(h, mainDeposit, target, strikerTol, broadTol, runMin);
    if (row) outRows.push(row);
  }

  const inRows: ClassifiedRow[] = [];
  for (const h of Array.from(inHashSet)) {
    const row = await classifyInHash(h, cbSpendSet, target, strikerTol, broadTol, runMin);
    if (row) inRows.push(row);
  }

  for (const r of outRows) {
    if (r.blockTime <= 0) r.blockTime = await blockTimeForTx(r.hash);
  }
  for (const r of inRows) {
    if (r.blockTime <= 0) r.blockTime = await blockTimeForTx(r.hash);
  }

  const sortLegs = (rows: ClassifiedRow[]) => {
    rows.sort((a, b) => {
      if (a.blockTime !== b.blockTime) return a.blockTime - b.blockTime;
      if (a.kind !== b.kind) return a.kind === 'runup' ? -1 : 1;
      return a.hash.localeCompare(b.hash);
    });
  };
  sortLegs(outRows);
  sortLegs(inRows);

  const nextDay: DayPayload = {
    ...nextDayBase,
    outHashes: outRows.map((r) => r.hash),
    inHashes: inRows.map((r) => r.hash),
  };

  for (let i = 1; i < outRows.length; i++) {
    const prev = outRows[i - 1]!;
    const cur = outRows[i]!;
    if (prev.kind !== 'runup' || cur.kind !== 'striker') continue;
    if (nextDay.emittedPairShortStrikerTxid === cur.hash) break;
    const tx = await fetchTx(cur.hash);
    if (!tx) continue;
    outSignals.push(buildSignal(tx, 'second_out_short', mainDeposit, transferBase, cbSpendSet));
    nextDay.emittedPairShortStrikerTxid = cur.hash;
    break;
  }

  for (let i = 1; i < inRows.length; i++) {
    const prev = inRows[i - 1]!;
    const cur = inRows[i]!;
    if (prev.kind !== 'runup' || cur.kind !== 'striker') continue;
    if (nextDay.emittedPairLongStrikerTxid === cur.hash) break;
    const tx = await fetchTx(cur.hash);
    const bt = tx?.status?.block_time ?? 0;
    if (!tx || bt <= 0 || !blockTimeAfterOpenEt(bt, longAfterMin)) continue;
    if (!isBlkLongBuyAllowedForBlockTimeEt(bt)) continue;
    outSignals.push(buildSignal(tx, 'second_in_long', mainDeposit, transferBase, cbSpendSet));
    nextDay.emittedPairLongStrikerTxid = cur.hash;
    break;
  }

  /** Long on 2nd ~300 BTC striker (CB→BR), chronological — e.g. two 300s in a row. */
  if (isArkhamSecondStrikerLongEnabled()) {
    const strikers = inRows.filter((r) => r.kind === 'striker');
    for (let i = 1; i < strikers.length; i++) {
      const cur = strikers[i]!;
      if (nextDay.emittedSecondStrikerInLongTxid === cur.hash) break;
      const tx = await fetchTx(cur.hash);
      const bt = tx?.status?.block_time ?? 0;
      if (!tx || bt <= 0 || !blockTimeAfterOpenEt(bt, longAfterMin)) continue;
      if (!isBlkLongBuyAllowedForBlockTimeEt(bt)) continue;
      const dup = outSignals.some((s) => s.txid.toLowerCase() === cur.hash.toLowerCase());
      if (dup) {
        nextDay.emittedSecondStrikerInLongTxid = cur.hash;
        break;
      }
      outSignals.push(buildSignal(tx, 'second_striker_in_long', mainDeposit, transferBase, cbSpendSet));
      nextDay.emittedSecondStrikerInLongTxid = cur.hash;
      break;
    }
  }

  saveArkhamBatchDayState(nextDay);
  return { signals: outSignals };
}
