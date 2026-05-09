import { NextRequest, NextResponse } from 'next/server';
import { runHyperliquidHourlyTick } from '@/lib/hyperliquid/hourly-bands';

export const dynamic = 'force-dynamic';

/** Manual / cron trigger. Body optional: `{ "bypassMinuteGate": true }` to run even before :afterMin UTC. */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { bypassMinuteGate?: boolean };
    const r = await runHyperliquidHourlyTick({
      bypassMinuteGate: body.bypassMinuteGate === true,
    });
    return NextResponse.json({ success: r.ok, result: r });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
