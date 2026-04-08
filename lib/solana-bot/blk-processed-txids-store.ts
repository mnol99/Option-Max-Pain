/**
 * Server-side BLK / IBIT dedupe — survives refresh and works across browsers.
 * - **txids**: already processed (poll does not re-emit)
 * - **tradedShortEtDayKeys** / **tradedLongEtDayKeys**: separate ET-day gates for short vs long BLK sessions
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

interface PayloadV3 {
  v: 3;
  txids: string[];
  tradedShortEtDayKeys: string[];
  tradedLongEtDayKeys: string[];
}

let memoryTxids: Set<string> | null = null;
let memoryShortDays: Set<string> | null = null;
let memoryLongDays: Set<string> | null = null;

function loadAll(): {
  txids: Set<string>;
  shortDays: Set<string>;
  longDays: Set<string>;
} {
  if (memoryTxids && memoryShortDays && memoryLongDays) {
    return { txids: memoryTxids, shortDays: memoryShortDays, longDays: memoryLongDays };
  }
  memoryTxids = new Set();
  memoryShortDays = new Set();
  memoryLongDays = new Set();
  try {
    const file = getStorePath();
    if (!fs.existsSync(file)) {
      return { txids: memoryTxids, shortDays: memoryShortDays, longDays: memoryLongDays };
    }
    const raw = fs.readFileSync(file, 'utf8');
    const p = JSON.parse(raw) as
      | PayloadV3
      | { v: 2; txids: string[]; tradedEtDayKeys: string[] }
      | { v: 1; txids: string[] };

    if ((p as PayloadV3).v === 3 && Array.isArray((p as PayloadV3).tradedShortEtDayKeys)) {
      const v3 = p as PayloadV3;
      for (const t of v3.txids ?? []) {
        if (typeof t === 'string' && t.length > 0) memoryTxids.add(t.toLowerCase());
      }
      for (const d of v3.tradedShortEtDayKeys ?? []) {
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) memoryShortDays.add(d);
      }
      for (const d of v3.tradedLongEtDayKeys ?? []) {
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) memoryLongDays.add(d);
      }
    } else if ((p as { v?: number }).v === 2 && 'tradedEtDayKeys' in p) {
      const v2 = p as { txids?: string[]; tradedEtDayKeys?: string[] };
      for (const t of v2.txids ?? []) {
        if (typeof t === 'string' && t.length > 0) memoryTxids.add(t.toLowerCase());
      }
      for (const d of v2.tradedEtDayKeys ?? []) {
        if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
          memoryShortDays.add(d);
          memoryLongDays.add(d);
        }
      }
    } else if ((p as { v?: number }).v === 1 && Array.isArray((p as { txids?: string[] }).txids)) {
      for (const t of (p as { txids: string[] }).txids) {
        if (typeof t === 'string' && t.length > 0) memoryTxids.add(t.toLowerCase());
      }
    }
  } catch {
    memoryTxids = new Set();
    memoryShortDays = new Set();
    memoryLongDays = new Set();
  }
  return { txids: memoryTxids!, shortDays: memoryShortDays!, longDays: memoryLongDays! };
}

function persistV3(txids: Set<string>, shortDays: Set<string>, longDays: Set<string>): void {
  try {
    const file = getStorePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload: PayloadV3 = {
      v: 3,
      txids: Array.from(txids).slice(-MAX_TXIDS),
      tradedShortEtDayKeys: Array.from(shortDays).slice(-MAX_DAY_KEYS),
      tradedLongEtDayKeys: Array.from(longDays).slice(-MAX_DAY_KEYS),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
    memoryTxids = txids;
    memoryShortDays = shortDays;
    memoryLongDays = longDays;
  } catch {
    /* read-only fs */
  }
}

export function getBlkServerProcessedTxids(): Set<string> {
  return new Set(loadAll().txids);
}

export function getBlkServerTradedShortEtDayKeys(): Set<string> {
  return new Set(loadAll().shortDays);
}

export function getBlkServerTradedLongEtDayKeys(): Set<string> {
  return new Set(loadAll().longDays);
}

/** @deprecated use getBlkServerTradedShortEtDayKeys — kept for callers that merged both */
export function getBlkServerTradedEtDayKeys(): Set<string> {
  const { shortDays, longDays } = loadAll();
  return new Set([...Array.from(shortDays), ...Array.from(longDays)]);
}

export function mergeBlkProcessedTxids(txids: string[]): void {
  const { txids: set, shortDays, longDays } = loadAll();
  let changed = false;
  for (const t of txids) {
    const k = t.trim().toLowerCase();
    if (!k) continue;
    if (!set.has(k)) {
      set.add(k);
      changed = true;
    }
  }
  if (changed) persistV3(set, shortDays, longDays);
}

export function mergeBlkTradedShortEtDayKeys(keys: string[]): void {
  const { txids, shortDays, longDays } = loadAll();
  let changed = false;
  for (const d of keys) {
    const k = d.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    if (!shortDays.has(k)) {
      shortDays.add(k);
      changed = true;
    }
  }
  if (changed) persistV3(txids, shortDays, longDays);
}

export function mergeBlkTradedLongEtDayKeys(keys: string[]): void {
  const { txids, shortDays, longDays } = loadAll();
  let changed = false;
  for (const d of keys) {
    const k = d.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    if (!longDays.has(k)) {
      longDays.add(k);
      changed = true;
    }
  }
  if (changed) persistV3(txids, shortDays, longDays);
}

export function mergeBlkDedupe(payload: {
  txids?: string[];
  tradedShortEtDayKeys?: string[];
  tradedLongEtDayKeys?: string[];
  /** legacy single list — applies to both */
  tradedEtDayKeys?: string[];
}): void {
  if (payload.txids?.length) mergeBlkProcessedTxids(payload.txids);
  if (payload.tradedShortEtDayKeys?.length) mergeBlkTradedShortEtDayKeys(payload.tradedShortEtDayKeys);
  if (payload.tradedLongEtDayKeys?.length) mergeBlkTradedLongEtDayKeys(payload.tradedLongEtDayKeys);
  if (payload.tradedEtDayKeys?.length) {
    mergeBlkTradedShortEtDayKeys(payload.tradedEtDayKeys);
    mergeBlkTradedLongEtDayKeys(payload.tradedEtDayKeys);
  }
}

export function clearBlkServerProcessedTxids(): void {
  memoryTxids = null;
  memoryShortDays = null;
  memoryLongDays = null;
  try {
    const file = getStorePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
