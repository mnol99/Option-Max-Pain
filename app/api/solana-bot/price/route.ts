import { NextResponse } from 'next/server';
import { fetchPythPrice } from '@/lib/solana-bot/pyth-price';
import { fetchDovesPrice } from '@/lib/solana-bot/doves-oracle';

/** Use Pyth for display (matches CoinGecko/Birdeye). Set to "doves" to use Jupiter Perps oracle. */
const PRICE_SOURCE = process.env.SOLANA_PRICE_SOURCE || 'pyth';

export async function GET() {
  try {
    const fetcher = PRICE_SOURCE === 'doves' ? fetchDovesPrice : fetchPythPrice;
    const { price, timestamp } = await fetcher();
    return NextResponse.json({
      success: true,
      data: { price, timestamp },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
