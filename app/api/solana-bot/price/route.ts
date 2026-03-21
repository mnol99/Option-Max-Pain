import { NextResponse } from 'next/server';
import { fetchPrice } from '@/lib/solana-bot/birdeye';

export async function GET() {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { success: false, error: 'BIRDEYE_API_KEY not configured' },
      { status: 500 }
    );
  }

  try {
    const price = await fetchPrice(apiKey);
    return NextResponse.json({
      success: true,
      data: { price, timestamp: Math.floor(Date.now() / 1000) },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
