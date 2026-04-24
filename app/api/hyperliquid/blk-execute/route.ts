import { NextRequest, NextResponse } from 'next/server';
import { executeHyperliquidBlkMarket } from '@/lib/hyperliquid/blk-execute';
import { getHyperliquidPrivateKey } from '@/lib/hyperliquid/config';

/**
 * BLK / IBIT live: IOC market-style perp orders on Hyperliquid (server-only; requires HL_API_PRIVATE_KEY).
 */
export async function POST(req: NextRequest) {
  if (!getHyperliquidPrivateKey()) {
    return NextResponse.json(
      { success: false, error: 'Set HL_API_PRIVATE_KEY (0x...) for BLK on Hyperliquid' },
      { status: 503 }
    );
  }

  try {
    const body = await req.json();
    const { side, notionalUsd, leverage = 1.5, reduceOnly = false } = body as {
      side: 'long' | 'short';
      notionalUsd?: number;
      leverage?: number;
      reduceOnly?: boolean;
    };

    if (side !== 'long' && side !== 'short') {
      return NextResponse.json({ success: false, error: 'Invalid side' }, { status: 400 });
    }

    const n = Number(notionalUsd);
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ success: false, error: 'notionalUsd must be positive' }, { status: 400 });
    }

    const lev = Number(leverage);
    const r = await executeHyperliquidBlkMarket({
      side,
      notionalUsd: n,
      leverage: Number.isFinite(lev) && lev >= 1 ? lev : 1.5,
      reduceOnly: reduceOnly === true,
    });

    if (!r.ok) {
      return NextResponse.json({ success: false, error: r.error }, { status: r.status ?? 400 });
    }
    return NextResponse.json({ success: true, data: { detail: r.detail } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hl-blk] execute', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
