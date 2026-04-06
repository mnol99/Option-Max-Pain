import { NextRequest, NextResponse } from 'next/server';
import {
  clearBlkServerProcessedTxids,
  mergeBlkDedupe,
} from '@/lib/solana-bot/blk-processed-txids-store';

export const dynamic = 'force-dynamic';

/** Merge client txids + traded ET day keys into server-side store (survives refresh). */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      txids?: string[];
      tradedEtDayKeys?: string[];
    };
    const txids = Array.isArray(body.txids) ? body.txids : [];
    const tradedEtDayKeys = Array.isArray(body.tradedEtDayKeys) ? body.tradedEtDayKeys : [];
    mergeBlkDedupe({ txids, tradedEtDayKeys });
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
