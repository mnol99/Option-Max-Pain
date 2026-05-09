import { NextResponse } from 'next/server';
import { resetInsideBarServerStateAndPersist } from '@/lib/solana-bot/inside-bar-server-state';

export const dynamic = 'force-dynamic';

/** Clears server-side inside-bar paper state (trades, positions, pattern refs) and persists empty snapshot. */
export async function POST() {
  try {
    resetInsideBarServerStateAndPersist();
    return NextResponse.json({ success: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
