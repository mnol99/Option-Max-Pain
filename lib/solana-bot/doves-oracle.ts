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

/**
 * Fetch current SOL/USD price from Doves oracle (Jupiter Perps feed)
 */
export async function fetchDovesPrice(): Promise<{ price: number; timestamp: number }> {
  const connection = getConnection();
  const accountInfo = await connection.getAccountInfo(SOL_PRICE_FEED);
  if (!accountInfo?.data || accountInfo.data.length < TIMESTAMP_OFFSET + 8) {
    throw new Error('Doves oracle: invalid or missing SOL price feed account');
  }

  const data = accountInfo.data;
  const priceRaw = data.readBigUInt64LE(PRICE_OFFSET);
  const expo = data.readInt8(EXPO_OFFSET);
  const timestamp = Number(data.readBigInt64LE(TIMESTAMP_OFFSET));

  // price (u64) * 10^expo = USD value (expo is typically negative, e.g. -9)
  const price = Number(priceRaw) * Math.pow(10, expo);

  return { price, timestamp };
}
