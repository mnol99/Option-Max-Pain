/**
 * Append-only JSON log for mean-reversion bot (signals, entries, exits).
 */

import { promises as fs } from 'fs';
import path from 'path';

const LOG_DIR = process.env.MEAN_REV_LOG_DIR || path.join(process.cwd(), 'data');
const LOG_FILE = path.join(LOG_DIR, 'mean-reversion-events.jsonl');

export type MeanRevLogEvent = {
  ts: string;
  type:
    | 'signal'
    | 'entry'
    | 'exit'
    | 'tp1'
    | 'tp2'
    | 'stop'
    | 'breakeven'
    | 'info';
  asset: 'sol' | 'btc';
  direction?: 'long' | 'short';
  message?: string;
  entryPrice?: number;
  exitPrice?: number;
  pnlUsd?: number;
  meta?: Record<string, unknown>;
};

async function ensureDir(): Promise<void> {
  await fs.mkdir(LOG_DIR, { recursive: true });
}

export async function logMeanRevEvent(event: MeanRevLogEvent): Promise<void> {
  await ensureDir();
  const line = JSON.stringify(event) + '\n';
  await fs.appendFile(LOG_FILE, line, 'utf8');
}

export function getMeanRevLogPath(): string {
  return LOG_FILE;
}
