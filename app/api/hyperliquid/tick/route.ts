import { NextResponse } from 'next/server';
import { runHyperliquidHourlyTick } from '@/lib/hyperliquid/hourly-bands';

export const dynamic = 'force-dynamic';

/** Manual / cron trigger: one hourly-band attempt (respects same rules as the heartbeat). */
export async function POST() {
  try {
    const r = await runHyperliquidHourlyTick();
    return NextResponse.json({ success: r.ok, result: r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
