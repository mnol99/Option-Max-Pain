import { NextResponse } from 'next/server';
import {
  tickMeanReversion,
  getMeanRevAccountUsd,
  getMeanRevPositionSizeUsd,
} from '@/lib/solana-bot/mean-reversion-state';
import { getMeanRevLogPath } from '@/lib/solana-bot/mean-reversion-logger';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const data = await tickMeanReversion();
    return NextResponse.json({
      success: true,
      data: {
        ...data,
        logFile: getMeanRevLogPath(),
        accountUsd: getMeanRevAccountUsd(),
        positionSizeUsd: getMeanRevPositionSizeUsd(),
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
