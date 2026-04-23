import { NextRequest, NextResponse } from 'next/server';
import { saveHlUiConfig, getHlUiConfig, type HlUiConfig } from '@/lib/hyperliquid/ui-config';
import { isHyperliquidHourlyEnabled } from '@/lib/hyperliquid/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    success: true,
    data: { ...getHlUiConfig(), envHourlyEnabled: isHyperliquidHourlyEnabled() },
  });
}

/**
 * Optional UI overrides (collateral USD, leverage, symbol, :after minute, run/pause).
 * Private key still comes from HL_API_PRIVATE_KEY in .env.local only.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as HlUiConfig;
    const cur = getHlUiConfig();
    const next: HlUiConfig = { ...cur };
    if (Object.keys(body).length === 0) {
      return NextResponse.json({ success: true, data: cur });
    }
    if (body.collateralUsd != null) {
      const n = Number(body.collateralUsd);
      if (Number.isFinite(n) && n > 0) next.collateralUsd = n;
    }
    if (body.leverage != null) {
      const n = Number(body.leverage);
      if (Number.isFinite(n) && n >= 1) next.leverage = Math.min(50, n);
    }
    if (body.coin != null && String(body.coin).trim()) {
      next.coin = String(body.coin).trim().toUpperCase();
    }
    if (body.afterMinute != null) {
      const n = Math.floor(Number(body.afterMinute));
      if (Number.isFinite(n) && n >= 0 && n <= 30) next.afterMinute = n;
    }
    if (body.enabled != null) {
      next.enabled = Boolean(body.enabled);
    }
    saveHlUiConfig(next);
    return NextResponse.json({ success: true, data: next });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
