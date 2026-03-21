import { NextResponse } from 'next/server';
import {
  getCandles,
  get5mBoundary,
  getWarmupMinutes,
} from '@/lib/solana-bot/candle-aggregator';

export async function GET() {
  try {
    const candles = getCandles();
    const now = Math.floor(Date.now() / 1000);
    const warmupMinutes = getWarmupMinutes();

    return NextResponse.json({
      success: true,
      data: candles,
      currentBoundary: get5mBoundary(now),
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
