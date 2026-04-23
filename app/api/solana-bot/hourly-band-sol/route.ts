import { NextResponse } from 'next/server';
import { runHourlyBandSolTick, loadHourlyBandSolState } from '@/lib/solana-bot/hourly-band-sol';

export const dynamic = 'force-dynamic';

/** Optional trigger for tests / ops. GET returns last state; POST runs one tick. */
export async function GET() {
  try {
    const s = loadHourlyBandSolState();
    return NextResponse.json({ success: true, data: s });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: m }, { status: 500 });
  }
}

export async function POST() {
  try {
    const d = await runHourlyBandSolTick();
    return NextResponse.json({ success: true, data: d, state: loadHourlyBandSolState() });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: m }, { status: 500 });
  }
}
