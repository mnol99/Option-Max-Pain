import { NextRequest, NextResponse } from 'next/server';
import { hyperliquidCancelOrders } from '@/lib/hyperliquid/exchange-helpers';

export const dynamic = 'force-dynamic';

/** POST `{ "coin": "SOL", "oid": 123 }` — cancel one open order (HL API wallet must match). */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { coin?: string; oid?: number };
    const coin = String(body.coin ?? '').trim().toUpperCase();
    const oid = Number(body.oid);
    if (!coin || !Number.isFinite(oid)) {
      return NextResponse.json(
        { success: false, error: 'Body must include coin (string) and oid (number)' },
        { status: 400 }
      );
    }
    const r = await hyperliquidCancelOrders([{ coin, oid }]);
    if (!r.ok) {
      return NextResponse.json({ success: false, error: r.error }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
