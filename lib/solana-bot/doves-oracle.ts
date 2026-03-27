/**
 * Doves Oracle - Jupiter Perps price feed
 * Reads SOL/USD price from the on-chain Doves oracle used by Jupiter Perpetuals.
 */

import { Connection, PublicKey } from '@solana/web3.js';

const DOVES_PROGRAM_ID = new PublicKey('DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e');
/** SOL/USD price feed used by Jupiter Perps */
export const SOL_PRICE_FEED = new PublicKey('39cWjvHrpHNz2SbXv6ME4NPhqBDBd4KsjUYv5JkHEAJU');

const ANCHOR_DISCRIMINATOR_LEN = 8;
// priceFeed: pair[32] + signer[33] + price(u64) + expo(i8) + timestamp(i64) + bump(u8)
const PRICE_OFFSET = ANCHOR_DISCRIMINATOR_LEN + 32 + 33;
const EXPO_OFFSET = PRICE_OFFSET + 8;
const TIMESTAMP_OFFSET = EXPO_OFFSET + 1;

function getConnection(): Connection {
  const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC || process.env.SOLANA_RPC;
  return new Connection(rpc || 'https://api.mainnet-beta.solana.com', 'confirmed');
}

/** Coalesce RPC reads: public RPCs rate-limit repeated getAccountInfo on the same account. */
const MIN_FETCH_INTERVAL_MS = Number(process.env.DOVES_MIN_FETCH_INTERVAL_MS) || 5000;
/** When RPC returns 429, reuse last good price if younger than this (ms). */
const STALE_OK_MS = Number(process.env.DOVES_STALE_CACHE_MS) || 120000;

let lastFetch: { price: number; timestamp: number; wallMs: number } | null = null;

function decodePrice(data: Buffer): { price: number; timestamp: number } {
  const priceRaw = data.readBigUInt64LE(PRICE_OFFSET);
  const expo = data.readInt8(EXPO_OFFSET);
  const timestamp = Number(data.readBigInt64LE(TIMESTAMP_OFFSET));
  const price = Number(priceRaw) * Math.pow(10, expo);
  return { price, timestamp };
}

/**
 * Fetch current SOL/USD price from Doves oracle (Jupiter Perps feed).
 * Uses in-memory throttling + stale fallback on 429 to avoid public RPC limits.
 */
export async function fetchDovesPrice(): Promise<{ price: number; timestamp: number }> {
  const now = Date.now();
  if (lastFetch && now - lastFetch.wallMs < MIN_FETCH_INTERVAL_MS) {
    return { price: lastFetch.price, timestamp: lastFetch.timestamp };
  }

  const connection = getConnection();
  try {
    const accountInfo = await connection.getAccountInfo(SOL_PRICE_FEED, 'processed');
    if (!accountInfo?.data || accountInfo.data.length < TIMESTAMP_OFFSET + 8) {
      throw new Error('Doves oracle: invalid or missing SOL price feed account');
    }
    const { price, timestamp } = decodePrice(accountInfo.data);
    lastFetch = { price, timestamp, wallMs: now };
    return { price, timestamp };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const is429 = msg.includes('429') || msg.includes('Too many requests');
    if (is429 && lastFetch && now - lastFetch.wallMs < STALE_OK_MS) {
      return { price: lastFetch.price, timestamp: lastFetch.timestamp };
    }
    if (is429) {
      throw new Error(
        'Solana RPC rate limit (429) reading Doves oracle. Set NEXT_PUBLIC_SOLANA_RPC to a dedicated provider (Helius, QuickNode, etc.) in .env.local, or wait and refresh.'
      );
    }
    throw e;
  }
}
