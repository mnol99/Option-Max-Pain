import { NextRequest, NextResponse } from 'next/server';
import { fetchHistoricalOHLCV } from '@/lib/solana-bot/birdeye-historical';
import { runBacktest } from '@/lib/solana-bot/backtest';

export async function GET(req: NextRequest) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'BIRDEYE_API_KEY required for backtest. Add to .env.local' },
      { status: 500 }
    );
  }

  const hours = Math.min(24, Math.max(1, parseInt(req.nextUrl.searchParams.get('hours') || '6', 10)));

  try {
    const now = Math.floor(Date.now() / 1000);
    const timeTo = now;
    const timeFrom = now - hours * 3600;

    const candles = await fetchHistoricalOHLCV(timeFrom, timeTo, apiKey, '5m');

    if (candles.length < 5) {
      return NextResponse.json({
        success: true,
        data: null,
        error: `Not enough candles (${candles.length}). Need at least 5 for backtest. Try more hours.`,
      });
    }

    const report = runBacktest(candles);

    return NextResponse.json({
      success: true,
      data: {
        ...report,
        hours,
        timeFrom,
        timeTo,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
