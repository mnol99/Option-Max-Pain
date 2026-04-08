/**
 * Per-ET-day ordering of qualifying Arkham batch transfers (~300 BTC) for "2nd transfer" triggers.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_PATH = '.data/arkham-batch-counts.json';

export interface DayPayload {
  etDayKey: string;
  /** Blockstream-validated txids, oldest → newest (qualifying out: BR→CB) */
  outHashes: string[];
  /** Qualifying in: CB→BR */
  inHashes: string[];
  /** txid we already emitted as 2nd-out short signal */
  emittedSecondOutTxid: string | null;
  /** txid we already emitted as 2nd-in long signal */
  emittedSecondInTxid: string | null;
}

interface FilePayload {
  v: 1;
  day: DayPayload | null;
}

function pathFile(): string {
  const raw = process.env.ARKHAM_BATCH_STATE_PATH?.trim();
  if (raw) return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
  return path.join(process.cwd(), DEFAULT_PATH);
}

let memory: FilePayload | null = null;

function load(): FilePayload {
  if (memory) return memory;
  try {
    const f = pathFile();
    if (fs.existsSync(f)) {
      const p = JSON.parse(fs.readFileSync(f, 'utf8')) as FilePayload;
      if (p.v === 1) {
        memory = p;
        return memory;
      }
    }
  } catch {
    /* ignore */
  }
  memory = { v: 1, day: null };
  return memory;
}

function persist(data: FilePayload): void {
  try {
    const f = pathFile();
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, f);
    memory = data;
  } catch {
    /* read-only */
  }
}

export function getArkhamBatchDayState(etDayKey: string): DayPayload {
  const file = load();
  if (file.day?.etDayKey === etDayKey) {
    return {
      etDayKey: file.day.etDayKey,
      outHashes: [...(file.day.outHashes ?? [])],
      inHashes: [...(file.day.inHashes ?? [])],
      emittedSecondOutTxid: file.day.emittedSecondOutTxid ?? null,
      emittedSecondInTxid: file.day.emittedSecondInTxid ?? null,
    };
  }
  return {
    etDayKey,
    outHashes: [],
    inHashes: [],
    emittedSecondOutTxid: null,
    emittedSecondInTxid: null,
  };
}

export function saveArkhamBatchDayState(day: DayPayload): void {
  persist({ v: 1, day: { ...day } });
}

export function resetArkhamBatchDayState(): void {
  persist({ v: 1, day: null });
}
