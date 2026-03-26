import { NextRequest, NextResponse } from 'next/server';
import {
  getCandles,
  getCurrentCandleBoundary,
  getWarmupMinutes,
} from '@/lib/solana-bot/candle-aggregator';
import { parseIntervalParam } from '@/lib/solana-bot/candle-intervals';

export async function GET(req: NextRequest) {
  try {
    const intervalSec = parseIntervalParam(req.nextUrl.searchParams.get('interval'));
    const candles = getCandles(intervalSec);
    const now = Math.floor(Date.now() / 1000);
    const warmupMinutes = getWarmupMinutes(intervalSec);

    return NextResponse.json({
      success: true,
      data: candles,
      intervalSec,
      currentBoundary: getCurrentCandleBoundary(intervalSec),
      warmupMinutes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
