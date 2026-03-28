/**
 * Bitcoin chain reads via Blockstream API (no API key).
 */

const DEFAULT_BASE = 'https://blockstream.info/api';

export interface BlockstreamTxRef {
  txid: string;
  status: { block_time?: number; confirmed: boolean };
  vout: Array<{
    value: number;
    scriptpubkey_address?: string;
  }>;
}

function baseUrl(): string {
  return (process.env.BITCOIN_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
}

export async function fetchAddressTxs(address: string, limit = 25): Promise<BlockstreamTxRef[]> {
  const url = `${baseUrl()}/address/${encodeURIComponent(address)}/txs`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Blockstream ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as BlockstreamTxRef[];
  return Array.isArray(json) ? json.slice(0, limit) : [];
}

export function sumToAddresses(
  tx: BlockstreamTxRef,
  destinationSet: Set<string>
): { sats: number; destinations: string[] } {
  let sats = 0;
  const destinations: string[] = [];
  for (const o of tx.vout || []) {
    const a = o.scriptpubkey_address;
    if (a && destinationSet.has(a)) {
      sats += Math.round(o.value);
      destinations.push(a);
    }
  }
  return { sats, destinations };
}
