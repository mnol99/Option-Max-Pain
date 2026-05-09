/**
 * Pyth Network price feed - Hermes API
 * Free, no API key. Often matches CoinGecko/Birdeye. Use for accurate display price.
 */

const PYTH_HERMES = 'https://hermes.pyth.network';
/** SOL/USD price feed ID on Pyth */
const SOL_USD_FEED_ID = '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
/** BTC/USD */
const BTC_USD_FEED_ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
/** ETH/USD */
const ETH_USD_FEED_ID = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';

interface PythPriceResponse {
  parsed?: Array<{
    id: string;
    price?: { price: string; expo: number; publish_time: number };
  }>;
}

export async function fetchPythPrice(): Promise<{ price: number; timestamp: number }> {
  return fetchPythPriceByFeedId(SOL_USD_FEED_ID, 'SOL');
}

export async function fetchPythBtcPrice(): Promise<{ price: number; timestamp: number }> {
  return fetchPythPriceByFeedId(BTC_USD_FEED_ID, 'BTC');
}

export async function fetchPythEthPrice(): Promise<{ price: number; timestamp: number }> {
  return fetchPythPriceByFeedId(ETH_USD_FEED_ID, 'ETH');
}

async function fetchPythPriceByFeedId(
  feedId: string,
  label: string
): Promise<{ price: number; timestamp: number }> {
  const url = `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${feedId}&_=${Date.now()}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Pyth price failed: ${res.status}`);
  }
  const json: PythPriceResponse = await res.json();
  const parsed = json.parsed?.[0];
  if (!parsed?.price) {
    throw new Error(`Pyth: no ${label} price data`);
  }
  const { price: priceStr, expo, publish_time } = parsed.price;
  const price = Number(priceStr) * Math.pow(10, expo);
  return { price, timestamp: publish_time };
}
