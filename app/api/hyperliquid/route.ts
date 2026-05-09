import { NextResponse } from 'next/server';
import { getHyperliquidDashboardData } from '@/lib/hyperliquid/hourly-bands-snapshot';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await getHyperliquidDashboardData();
    return NextResponse.json({ success: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
