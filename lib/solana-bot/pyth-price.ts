/**
 * Pyth Network price feed - Hermes API
 * Free, no API key. Often matches CoinGecko/Birdeye. Use for accurate display price.
 */

const PYTH_HERMES = 'https://hermes.pyth.network';
/** SOL/USD price feed ID on Pyth */
const SOL_USD_FEED_ID = '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

interface PythPriceResponse {
  parsed?: Array<{
    id: string;
    price?: { price: string; expo: number; publish_time: number };
  }>;
}

export async function fetchPythPrice(): Promise<{ price: number; timestamp: number }> {
  const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${SOL_USD_FEED_ID}&_=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Pyth price failed: ${res.status}`);
  }
  const json: PythPriceResponse = await res.json();
  const parsed = json.parsed?.[0];
  if (!parsed?.price) {
    throw new Error('Pyth: no SOL price data');
  }
  const { price: priceStr, expo, publish_time } = parsed.price;
  const price = Number(priceStr) * Math.pow(10, expo);
  return { price, timestamp: publish_time };
}
