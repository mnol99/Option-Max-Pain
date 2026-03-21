/**
 * Jupiter Perps execution API
 * Builds createIncreasePositionMarketRequest transaction for client to sign & send.
 *
 * Full tx build: Anchor/IDL Borsh encoding ("indeterminate span") needs resolution.
 * PDA helpers & constants in lib/solana-bot/jupiter-perps.ts.
 */
import { NextRequest, NextResponse } from 'next/server';
import { PublicKey } from '@solana/web3.js';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { side, owner: ownerStr } = body as {
      side: 'long' | 'short';
      owner: string;
    };

    if (!ownerStr || !side || !['long', 'short'].includes(side)) {
      return NextResponse.json(
        { success: false, error: 'Invalid body: need side (long|short) and owner (pubkey)' },
        { status: 400 }
      );
    }

    try {
      new PublicKey(ownerStr);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid owner: not a valid Solana public key' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: false,
      error:
        'Jupiter Perps tx build: Anchor/IDL encoding in progress. Use Paper mode. ' +
        'PDA helpers in lib/solana-bot/jupiter-perps.ts.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
