/**
 * Bitcoin chain reads via Blockstream API (no API key).
 */

const DEFAULT_BASE = 'https://blockstream.info/api';

/** Prevout on inputs — present on full tx and on `/address/.../txs` list items from Blockstream. */
export interface BlockstreamVin {
  txid?: string;
  prevout?: {
    scriptpubkey_address?: string;
    value?: number;
  };
}

export interface BlockstreamTxRef {
  txid: string;
  status: { block_time?: number; confirmed: boolean };
  vin?: BlockstreamVin[];
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

/** Single tx by id (for IBIT_EXTRA_TXIDS / manual Arkham txids). */
export async function fetchTx(txid: string): Promise<BlockstreamTxRef | null> {
  const url = `${baseUrl()}/tx/${encodeURIComponent(txid)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  const json = (await res.json()) as BlockstreamTxRef;
  return json?.txid ? json : null;
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

/** Total sats sent to a single address (main Prime deposit leg). */
export function sumToAddress(tx: BlockstreamTxRef, address: string): number {
  let sats = 0;
  for (const o of tx.vout || []) {
    if (o.scriptpubkey_address === address) sats += Math.round(o.value);
  }
  return sats;
}

/** Total sats received at `address` when it appears as a spend input prevout (incoming to custodian). */
export function sumFromAddressAsInput(tx: BlockstreamTxRef, address: string): number {
  let sats = 0;
  for (const v of tx.vin || []) {
    if (v.prevout?.scriptpubkey_address === address) {
      sats += Math.round(v.prevout?.value ?? 0);
    }
  }
  return sats;
}

/** Sum prevout values for any address in `addresses` (Coinbase cluster spend → BR / external). */
export function sumFromAddressesAsInput(tx: BlockstreamTxRef, addresses: Set<string>): number {
  let sats = 0;
  for (const v of tx.vin || []) {
    const a = v.prevout?.scriptpubkey_address;
    if (a && addresses.has(a)) sats += Math.round(v.prevout?.value ?? 0);
  }
  return sats;
}

/**
 * Largest output (sats) whose address is **not** in `excludeAddresses` (e.g. exclude Coinbase change).
 * Used for CB→BR batch size (custodian receipt leg).
 */
export function maxOutputSatsExcludingAddresses(
  tx: BlockstreamTxRef,
  excludeAddresses: Set<string>
): number {
  let max = 0;
  for (const o of tx.vout || []) {
    const a = o.scriptpubkey_address;
    if (!a || excludeAddresses.has(a)) continue;
    max = Math.max(max, Math.round(o.value));
  }
  return max;
}

/** Distinct addresses appearing as spend inputs (prevouts). */
export function collectInputSourceAddresses(tx: BlockstreamTxRef): string[] {
  const set = new Set<string>();
  for (const v of tx.vin || []) {
    const a = v.prevout?.scriptpubkey_address;
    if (a) set.add(a);
  }
  return Array.from(set);
}

/** Address of the largest-value prevout (typical “feeder” UTXO for large transfers). */
export function primaryInputSourceAddress(tx: BlockstreamTxRef): string | null {
  let best: { addr: string; val: number } | null = null;
  for (const v of tx.vin || []) {
    const a = v.prevout?.scriptpubkey_address;
    const val = v.prevout?.value ?? 0;
    if (a && val > (best?.val ?? -1)) best = { addr: a, val };
  }
  return best?.addr ?? null;
}
