import { NextRequest, NextResponse } from 'next/server';
import {
  getMeanRevCandles15m,
  getMeanRevCandles1h,
  type MeanRevAsset,
} from '@/lib/solana-bot/dual-jupiter-candles';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const asset = (req.nextUrl.searchParams.get('asset') || 'sol') as MeanRevAsset;
  const tf = req.nextUrl.searchParams.get('tf') || '15m';
  if (asset !== 'sol' && asset !== 'btc') {
    return NextResponse.json({ success: false, error: 'asset must be sol|btc' }, { status: 400 });
  }
  const candles = tf === '1h' ? getMeanRevCandles1h(asset) : getMeanRevCandles15m(asset);
  return NextResponse.json({ success: true, data: { candles, asset, tf } });
}
