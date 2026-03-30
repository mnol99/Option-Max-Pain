/**
 * Background ticks for server-side inside-bar simulation (Node only).
 * Keeps time exits and pattern detection advancing when no browser is connected.
 */

const DEFAULT_MS = 15_000;

export function startInsideBarHeartbeat(): void {
  const ms = (() => {
    const raw = process.env.INSIDE_BAR_HEARTBEAT_MS;
    if (raw == null || raw === '') return DEFAULT_MS;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 5000 ? n : DEFAULT_MS;
  })();

  const run = async () => {
    try {
      const { tickInsideBarServerQueued, getDefaultInsideBarPositionUsd } = await import(
        './inside-bar-server-state'
      );
      await tickInsideBarServerQueued(undefined, getDefaultInsideBarPositionUsd(), {
        useChartPrice: false,
      });
    } catch {
      /* ignore */
    }
  };

  void run();
  setInterval(run, ms);
}
