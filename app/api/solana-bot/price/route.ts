import { NextRequest, NextResponse } from 'next/server';
import { fetchPythPrice, fetchPythBtcPrice, fetchPythEthPrice } from '@/lib/solana-bot/pyth-price';
import { fetchDovesPrice } from '@/lib/solana-bot/doves-oracle';

/** Use Doves (Jupiter Perps) by default - matches execution. Set to "pyth" for Pyth/aggregator price. */
const PRICE_SOURCE = process.env.SOLANA_PRICE_SOURCE || 'doves';

export async function GET(req: NextRequest) {
  try {
    const asset = req.nextUrl.searchParams.get('asset') || 'sol';
    let price: number;
    let timestamp: number;
    let outAsset: 'sol' | 'btc' | 'eth' = 'sol';
    if (asset === 'btc') {
      const r = await fetchPythBtcPrice();
      price = r.price;
      timestamp = r.timestamp;
      outAsset = 'btc';
    } else if (asset === 'eth') {
      const r = await fetchPythEthPrice();
      price = r.price;
      timestamp = r.timestamp;
      outAsset = 'eth';
    } else {
      const fetcher = PRICE_SOURCE === 'doves' ? fetchDovesPrice : fetchPythPrice;
      const r = await fetcher();
      price = r.price;
      timestamp = r.timestamp;
      outAsset = 'sol';
    }
    return NextResponse.json({
      success: true,
      data: { price, timestamp, asset: outAsset },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
