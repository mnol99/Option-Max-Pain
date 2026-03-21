/**
 * Jupiter Perps execution API
 * Builds createIncreasePositionMarketRequest transaction for client to sign & send.
 * Status: Scaffold - full integration requires custody fetch, proper scaling.
 */
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { side, owner: ownerStr, sizeUsd = 100 } = body as {
      side: 'long' | 'short';
      owner: string;
      sizeUsd?: number;
    };

    if (!ownerStr || !side || !['long', 'short'].includes(side)) {
      return NextResponse.json(
        { success: false, error: 'Invalid body: need side (long|short) and owner (pubkey)' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: false,
      error:
        'Jupiter Perps execution is in progress. Requires: USDC collateral for shorts, custody account fetch, proper token scaling. Use Paper mode meanwhile.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
