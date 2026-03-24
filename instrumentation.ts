/**
 * Next.js instrumentation - runs on server startup.
 * Starts the automated trading bot when TRADING_ENABLED=true.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { runAutoTrader, isAutoTraderEnabled } = await import(
      '@/lib/solana-bot/auto-trader'
    );
    if (isAutoTraderEnabled()) {
      runAutoTrader();
    }
  }
}
