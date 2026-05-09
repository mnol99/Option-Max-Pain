import { NextRequest, NextResponse } from 'next/server';
import {
  advanceCandlesOnce,
  getCandles,
  getCurrentCandleBoundary,
  getWarmupMinutes,
} from '@/lib/solana-bot/candle-aggregator';
import { parseIntervalParam } from '@/lib/solana-bot/candle-intervals';
import type { InsideBarUnderlying } from '@/lib/solana-bot/strategy-tabs';

function parseUnderlying(v: string | null): InsideBarUnderlying {
  if (v === 'btc' || v === 'eth' || v === 'sol') return v;
  return 'sol';
}

export async function GET(req: NextRequest) {
  try {
    const intervalSec = parseIntervalParam(req.nextUrl.searchParams.get('interval'));
    const underlying = parseUnderlying(req.nextUrl.searchParams.get('underlying'));
    await advanceCandlesOnce();
    const candles = getCandles(underlying, intervalSec);
    const now = Math.floor(Date.now() / 1000);
    const warmupMinutes = getWarmupMinutes(underlying, intervalSec);

    return NextResponse.json({
      success: true,
      data: candles,
      intervalSec,
      underlying,
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
