import { NextRequest, NextResponse } from 'next/server';
import {
  tickInsideBarServerQueued,
  getDefaultInsideBarPositionUsd,
  type InsideBarServerSnapshot,
} from '@/lib/solana-bot/inside-bar-server-state';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      clientSnapshot?: Partial<InsideBarServerSnapshot>;
      paperPositionSizeUsd?: number;
      useChartPrice?: boolean;
    };
    const positionUsd =
      typeof body.paperPositionSizeUsd === 'number' && body.paperPositionSizeUsd > 0
        ? body.paperPositionSizeUsd
        : getDefaultInsideBarPositionUsd();

    const result = await tickInsideBarServerQueued(body.clientSnapshot, positionUsd, {
      useChartPrice: body.useChartPrice === true,
    });

    return NextResponse.json({
      success: true,
      data: {
        snapshot: result.snapshot,
        price: result.price,
        priceTime: result.priceTime,
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
