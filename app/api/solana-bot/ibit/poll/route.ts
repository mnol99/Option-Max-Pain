import { NextResponse } from 'next/server';
import { pollIbitTransfers } from '@/lib/solana-bot/ibit-poll';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await pollIbitTransfers();
    return NextResponse.json({ success: true, data });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
