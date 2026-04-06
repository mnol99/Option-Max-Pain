import { NextRequest, NextResponse } from 'next/server';
import {
  clearBlkServerProcessedTxids,
  mergeBlkProcessedTxids,
} from '@/lib/solana-bot/blk-processed-txids-store';

export const dynamic = 'force-dynamic';

/** Merge client txids into server-side dedupe store (survives refresh). */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { txids?: string[] };
    const txids = Array.isArray(body.txids) ? body.txids : [];
    mergeBlkProcessedTxids(txids);
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

/** Clear server store — use when user clears BLK log in UI. */
export async function DELETE() {
  try {
    clearBlkServerProcessedTxids();
    return NextResponse.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
