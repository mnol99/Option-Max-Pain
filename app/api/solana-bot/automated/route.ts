/**
 * Automated trading status and control
 */
import { NextRequest, NextResponse } from 'next/server';
import { isAutoTraderRunning, getAutoTraderState, isAutoTraderEnabled } from '@/lib/solana-bot/auto-trader';

export async function GET() {
  const enabled = isAutoTraderEnabled();
  const running = isAutoTraderRunning();
  const { state, error } = getAutoTraderState();
  return NextResponse.json({
    success: true,
    data: {
      enabled,
      running,
      status: state.status,
      position: state.position,
      entryPrice: state.entryPrice,
      setup: state.setup ? { breakoutHigh: state.setup.breakoutHigh, breakoutLow: state.setup.breakoutLow } : null,
      error,
    },
  });
}
