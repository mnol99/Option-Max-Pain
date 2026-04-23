import { NextRequest, NextResponse } from 'next/server';
import {
  tickInsideBarServerQueued,
  getDefaultInsideBarPositionUsd,
  getDefaultInsideBarLiveLeverage,
  type InsideBarServerSnapshot,
} from '@/lib/solana-bot/inside-bar-server-state';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      clientSnapshot?: Partial<InsideBarServerSnapshot>;
      paperPositionSizeUsd?: number;
      useChartPrice?: boolean;
      /** When true, position size and optional leverage are for *live* server-side ticks + Jupiter. */
      liveMode?: boolean;
      livePositionSizeUsd?: number;
      liveLeverage?: number;
    };
    const live = body.liveMode === true;
    const positionUsd =
      live && typeof body.livePositionSizeUsd === 'number' && body.livePositionSizeUsd > 0
        ? body.livePositionSizeUsd
        : !live && typeof body.paperPositionSizeUsd === 'number' && body.paperPositionSizeUsd > 0
          ? body.paperPositionSizeUsd
          : getDefaultInsideBarPositionUsd();

    const result = await tickInsideBarServerQueued(body.clientSnapshot, positionUsd, {
      useChartPrice: body.useChartPrice === true,
      liveLeverage:
        live && typeof body.liveLeverage === 'number' && body.liveLeverage >= 1
          ? body.liveLeverage
          : live
            ? getDefaultInsideBarLiveLeverage()
            : undefined,
    });

    return NextResponse.json({
      success: true,
      data: {
        snapshot: result.snapshot,
        price: result.price,
        priceTime: result.priceTime,
        pricesByStrategy: result.pricesByStrategy,
        candlesByStrategy: result.candlesByStrategy,
        newTrades: result.newTrades,
        warmupByStrategy: result.warmupByStrategy,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
