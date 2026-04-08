/**
 * Arkham Intel API — Bitcoin transfers for IBIT / entity monitoring.
 * Docs: https://intel.arkm.com/llms/get-transfers.md — header: API-Key
 */

const ARKM_BASE = 'https://api.arkm.com';

/** Minimal shape from GET /transfers (bitcoin). */
interface ArkhamEnrichedTransfer {
  chain?: string;
  transactionHash?: string;
  blockTimestamp?: string;
  unitValue?: number;
  fromAddress?: { address?: string };
  toAddress?: { address?: string };
  historicalUSD?: number;
}

interface ArkhamTransfersResponse {
  count?: number;
  transfers?: ArkhamEnrichedTransfer[];
}

export interface ArkhamBitcoinOutParams {
  apiKey: string;
  /** Entity or address for `base` filter (e.g. blackrock, or an Arkham entity id from the UI). */
  transferBase: string;
  /** Max rows (API default 50). */
  limit: number;
  /** e.g. 7d, 24h — Arkham `timeLast` */
  timeLast: string;
  /** `out` = from base, `in` = to base (see Arkham GET /transfers). */
  flow?: 'in' | 'out';
  /** Optional counterparty entity slug (e.g. coinbase) — restricts to base ↔ counterparty. */
  counterparties?: string;
}

/**
 * Bitcoin transfers for `base` + optional `flow` / `counterparties`.
 * Rate limit: 1 req/s on /transfers — space sequential calls by ≥1s.
 */
export async function fetchArkhamBitcoinTransfersForBase(
  params: ArkhamBitcoinOutParams
): Promise<{ transfers: ArkhamEnrichedTransfer[]; error?: string }> {
  const q = new URLSearchParams();
  q.set('base', params.transferBase);
  q.set('chains', 'bitcoin');
  q.set('flow', params.flow ?? 'out');
  if (params.counterparties?.trim()) {
    q.set('counterparties', params.counterparties.trim());
  }
  q.set('sortKey', 'time');
  q.set('sortDir', 'asc');
  q.set('limit', String(Math.min(100, Math.max(1, params.limit))));
  q.set('timeLast', params.timeLast);

  const url = `${ARKM_BASE}/transfers?${q.toString()}`;
  try {
    const res = await fetch(url, {
      headers: { 'API-Key': params.apiKey },
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text();
      return { transfers: [], error: `Arkham ${res.status}: ${text.slice(0, 500)}` };
    }
    const json = (await res.json()) as ArkhamTransfersResponse;
    const list = json.transfers ?? [];
    const bitcoin = list.filter((t) => (t.chain || '').toLowerCase() === 'bitcoin');
    return { transfers: bitcoin };
  } catch (e) {
    return {
      transfers: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function arkhamTxHash(t: ArkhamEnrichedTransfer): string | null {
  const h = t.transactionHash?.trim();
  return h || null;
}
