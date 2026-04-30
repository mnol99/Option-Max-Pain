/**
 * Background ticks for server-side inside-bar simulation (Node only).
 * Keeps time exits and pattern detection advancing when no browser is connected.
 */

/** Match client `/inside-bar/tick` cadence when unset — 15s was too slow when the tab sleeps. */
const DEFAULT_MS = 3000;

export function startInsideBarHeartbeat(): void {
  /** Same as `/trade` BLK-only mode: NEXT_PUBLIC_* (after `npm run build`) + optional server-only duplicate for heartbeat after restart only. */
  if (
    process.env.NEXT_PUBLIC_INSIDE_BAR_DISABLE_TRADE_AUTOMATION === '1' ||
    process.env.INSIDE_BAR_DISABLE_TRADE_AUTOMATION === '1'
  ) {
    console.warn('[inside-bar-heartbeat] disabled — no 60m/Daily server ticks (BLK + IBIT poll unchanged)');
    return;
  }

  const ms = (() => {
    const raw = process.env.INSIDE_BAR_HEARTBEAT_MS;
    if (raw == null || raw === '') return DEFAULT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_MS;
  })();

  console.warn(`[inside-bar-heartbeat] started every ${ms}ms`);

  const run = async () => {
    try {
      const {
        tickInsideBarServerQueued,
        getDefaultInsideBarPositionUsd,
        getDefaultInsideBarLiveLeverage,
      } = await import('./inside-bar-server-state');
      const serverLive = process.env.INSIDE_BAR_SERVER_LIVE_EXECUTE === '1';
      await tickInsideBarServerQueued(undefined, getDefaultInsideBarPositionUsd(), {
        useChartPrice: false,
        liveLeverage: serverLive ? getDefaultInsideBarLiveLeverage() : undefined,
      });
    } catch {
      /* ignore */
    }
  };

  void run();
  setInterval(run, ms);
}
