/**
 * Server-side BLK / IBIT dedupe — survives refresh and works across browsers.
 * - **txids**: already processed (poll does not re-emit)
 * - **tradedEtDayKeys**: ET calendar days (YYYY-MM-DD) that already had a BLK session — blocks a
 *   second open the same day when IBIT sends multiple transfers (different txids) in one morning.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_TXIDS = 2000;
const MAX_DAY_KEYS = 400;

function getStorePath(): string {
  const raw = process.env.BLK_PROCESSED_TXIDS_PATH?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  return path.join(process.cwd(), '.data', 'blk-processed-txids.json');
}

interface PayloadV2 {
  v: 2;
  txids: string[];
  tradedEtDayKeys: string[];
}

let memoryTxids: Set<string> | null = null;
let memoryDays: Set<string> | null = null;

function loadBoth(): { txids: Set<string>; days: Set<string> } {
  if (memoryTxids && memoryDays) {
    return { txids: memoryTxids, days: memoryDays };
  }
  memoryTxids = new Set();
  memoryDays = new Set();
  try {
    const file = getStorePath();
    if (!fs.existsSync(file)) return { txids: memoryTxids, days: memoryDays };
    const raw = fs.readFileSync(file, 'utf8');
    const p = JSON.parse(raw) as PayloadV2 | { v: 1; txids: string[] };
    if (p.v === 2 && Array.isArray(p.txids) && Array.isArray(p.tradedEtDayKeys)) {
      for (const t of p.txids) {
        if (typeof t === 'string' && t.length > 0) memoryTxids.add(t.toLowerCase());
      }
      for (const d of p.tradedEtDayKeys) {
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) memoryDays.add(d);
      }
    } else if ((p as { v?: number }).v === 1 && Array.isArray((p as { txids?: string[] }).txids)) {
      for (const t of (p as { txids: string[] }).txids) {
        if (typeof t === 'string' && t.length > 0) memoryTxids.add(t.toLowerCase());
      }
    }
  } catch {
    memoryTxids = new Set();
    memoryDays = new Set();
  }
  return { txids: memoryTxids!, days: memoryDays! };
}

function persistV2(txids: Set<string>, days: Set<string>): void {
  try {
    const file = getStorePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload: PayloadV2 = {
      v: 2,
      txids: Array.from(txids).slice(-MAX_TXIDS),
      tradedEtDayKeys: Array.from(days).slice(-MAX_DAY_KEYS),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* read-only fs */
  }
}

export function getBlkServerProcessedTxids(): Set<string> {
  return new Set(loadBoth().txids);
}

export function getBlkServerTradedEtDayKeys(): Set<string> {
  return new Set(loadBoth().days);
}

export function mergeBlkProcessedTxids(txids: string[]): void {
  const { txids: set, days } = loadBoth();
  let changed = false;
  for (const t of txids) {
    const k = t.trim().toLowerCase();
    if (!k) continue;
    if (!set.has(k)) {
      set.add(k);
      changed = true;
    }
  }
  if (changed) persistV2(set, days);
}

export function mergeBlkTradedEtDayKeys(keys: string[]): void {
  const { txids, days } = loadBoth();
  let changed = false;
  for (const d of keys) {
    const k = d.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    if (!days.has(k)) {
      days.add(k);
      changed = true;
    }
  }
  if (changed) persistV2(txids, days);
}

export function mergeBlkDedupe(payload: { txids?: string[]; tradedEtDayKeys?: string[] }): void {
  if (payload.txids?.length) mergeBlkProcessedTxids(payload.txids);
  if (payload.tradedEtDayKeys?.length) mergeBlkTradedEtDayKeys(payload.tradedEtDayKeys);
}

export function clearBlkServerProcessedTxids(): void {
  memoryTxids = null;
  memoryDays = null;
  try {
    const file = getStorePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
