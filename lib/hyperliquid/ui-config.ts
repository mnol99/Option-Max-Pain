/**
 * Optional UI-persisted overrides (server file, not committed). Falls back to env.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), '.data', 'hl-ui-config.json');

export type HlUiConfig = {
  collateralUsd?: number;
  leverage?: number;
  coin?: string;
  afterMinute?: number;
  /** 1 = running (UI), 0 = paused */
  enabled?: boolean;
};

let cache: HlUiConfig | null = null;
let mtime = 0;

function readFile(): HlUiConfig {
  try {
    if (!fs.existsSync(FILE)) return {};
    const st = fs.statSync(FILE);
    if (st.mtimeMs === mtime && cache) return cache;
    mtime = st.mtimeMs;
    const raw = fs.readFileSync(FILE, 'utf8');
    cache = JSON.parse(raw) as HlUiConfig;
    return cache ?? {};
  } catch {
    return {};
  }
}

export function getHlUiConfig(): HlUiConfig {
  return readFile();
}

export function saveHlUiConfig(p: HlUiConfig): void {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
  cache = p;
  mtime = Date.now();
}
