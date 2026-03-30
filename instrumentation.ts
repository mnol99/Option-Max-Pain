/**
 * Next.js server bootstrap: keep inside-bar simulation advancing when no browser is connected.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startInsideBarHeartbeat } = await import('@/lib/solana-bot/inside-bar-heartbeat');
    startInsideBarHeartbeat();
  }
}
