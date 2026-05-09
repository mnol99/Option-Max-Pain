/**
 * Jupiter Perps execution API
 * Builds createIncreasePositionMarketRequest tx for client to sign & send,
 * or optionally signs and sends server-side (SOLANA_TRADING_SERVER_SIGNING=1).
 */
import { NextRequest, NextResponse } from 'next/server';
import { jupiterPerpExecuteMarket } from '@/lib/solana-bot/jupiter-perp-execute';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      side,
      owner: ownerStr,
      sizeUsd = 100,
      leverage = 1.5,
      solPrice,
      btcPrice,
      ethPrice,
      asset = 'sol',
      signAndSend = false,
    } = body as {
      side: 'long' | 'short';
      owner?: string;
      sizeUsd?: number;
      leverage?: number;
      solPrice?: number;
      btcPrice?: number;
      ethPrice?: number;
      asset?: 'sol' | 'btc' | 'eth';
      signAndSend?: boolean;
    };

    const r = await jupiterPerpExecuteMarket({
      side,
      owner: ownerStr,
      sizeUsd,
      leverage,
      solPrice,
      btcPrice,
      ethPrice,
      asset: asset as 'sol' | 'btc' | 'eth',
      signAndSend: signAndSend === true,
    });

    if (!r.ok) {
      return NextResponse.json(
        { success: false, error: r.error },
        { status: r.status ?? 400 }
      );
    }
    if ('signature' in r.data) {
      return NextResponse.json({
        success: true,
        data: { signature: r.data.signature, owner: r.data.owner },
      });
    }
    return NextResponse.json({ success: true, data: { serializedTx: r.data.serializedTx } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Execute error:', msg);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
