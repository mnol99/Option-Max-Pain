import { NextRequest, NextResponse } from 'next/server';
import { fetchOHLCV, get5mBoundary } from '@/lib/solana-bot/birdeye';

export async function GET(req: NextRequest) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'BIRDEYE_API_KEY not configured' },
      { status: 500 }
    );
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    // Fetch last 6 candles (need 4 for pattern, extra buffer)
    const timeTo = now;
    const timeFrom = now - 6 * 300; // 6 * 5min

    const candles = await fetchOHLCV(timeFrom, timeTo, apiKey);
    // Exclude in-progress candle: only use completed 5m candles (period ended)
    const completed = candles.filter((c) => (c.unixTime || 0) + 300 <= now);
    // Birdeye returns oldest first; we need newest first for pattern logic
    const sorted = [...completed].sort((a, b) => b.unixTime - a.unixTime);

    return NextResponse.json({
      success: true,
      data: sorted,
      currentBoundary: get5mBoundary(now),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
