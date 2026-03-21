import { NextResponse } from 'next/server';
import { fetchDovesPrice } from '@/lib/solana-bot/doves-oracle';

export async function GET() {
  try {
    const { price, timestamp } = await fetchDovesPrice();
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
