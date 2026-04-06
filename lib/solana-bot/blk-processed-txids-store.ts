/**
 * Server-side BLK / IBIT processed txids — survives refresh and works across browsers.
 * Client localStorage is still used for UI; this store is the source of truth for /ibit/poll.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_TXIDS = 2000;

function getStorePath(): string {
  const raw = process.env.BLK_PROCESSED_TXIDS_PATH?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  return path.join(process.cwd(), '.data', 'blk-processed-txids.json');
}

interface Payload {
  v: 1;
  txids: string[];
}

let memory: Set<string> | null = null;

function load(): Set<string> {
  if (memory) return memory;
  memory = new Set();
  try {
    const file = getStorePath();
    if (!fs.existsSync(file)) return memory;
    const raw = fs.readFileSync(file, 'utf8');
    const p = JSON.parse(raw) as Payload;
    if (p.v !== 1 || !Array.isArray(p.txids)) return memory;
    for (const t of p.txids) {
      if (typeof t === 'string' && t.length > 0) memory.add(t.toLowerCase());
    }
  } catch {
    memory = new Set();
  }
  return memory;
}

function persist(set: Set<string>): void {
  try {
    const file = getStorePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const arr = Array.from(set).slice(-MAX_TXIDS);
    const payload: Payload = { v: 1, txids: arr };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* read-only fs */
  }
}

export function getBlkServerProcessedTxids(): Set<string> {
  return new Set(load());
}

export function mergeBlkProcessedTxids(txids: string[]): void {
  const set = load();
  let changed = false;
  for (const t of txids) {
    const k = t.trim().toLowerCase();
    if (!k) continue;
    if (!set.has(k)) {
      set.add(k);
      changed = true;
    }
  }
  if (changed) persist(set);
}

export function clearBlkServerProcessedTxids(): void {
  memory = new Set();
  try {
    const file = getStorePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
}
