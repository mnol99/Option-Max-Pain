import { NextRequest, NextResponse } from 'next/server';
import { hyperliquidPlaceLimitGtc } from '@/lib/hyperliquid/exchange-helpers';

export const dynamic = 'force-dynamic';

/**
 * POST place one GTC limit on chosen perp.
 * Body: `{ "coin": "SOL", "side": "buy"|"sell", "limitPx": number, "szCoin": number, "reduceOnly"?: boolean }`
 * `szCoin` = **base asset size** (e.g. SOL quantity for SOL), not USD notional.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      coin?: string;
      side?: string;
      limitPx?: number;
      szCoin?: number;
      reduceOnly?: boolean;
    };
    const coin = String(body.coin ?? '').trim().toUpperCase();
    const side = String(body.side ?? '').toLowerCase();
    const limitPx = Number(body.limitPx);
    const szCoin = Number(body.szCoin);
    if (!coin || (side !== 'buy' && side !== 'sell')) {
      return NextResponse.json(
        { success: false, error: 'coin and side (buy|sell) required' },
        { status: 400 }
      );
    }
    if (!Number.isFinite(limitPx) || !(limitPx > 0)) {
      return NextResponse.json({ success: false, error: 'limitPx must be positive' }, { status: 400 });
    }
    if (!Number.isFinite(szCoin) || !(szCoin > 0)) {
      return NextResponse.json({ success: false, error: 'szCoin (base size) must be positive' }, { status: 400 });
    }

    const r = await hyperliquidPlaceLimitGtc({
      coin,
      isBuy: side === 'buy',
      limitPx,
      szCoin,
      reduceOnly: body.reduceOnly === true,
    });
    if (!r.ok) {
      return NextResponse.json({ success: false, error: r.error }, { status: 400 });
    }
    return NextResponse.json({ success: true, detail: r.detail });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
