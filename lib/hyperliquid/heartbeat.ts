import { getHourlyLoopMs, isHyperliquidHourlyEnabled } from '@/lib/hyperliquid/config';
import { getHlUiConfig } from '@/lib/hyperliquid/ui-config';
import { runHyperliquidHourlyTick } from '@/lib/hyperliquid/hourly-bands';

/**
 * Node-only: poll and place hourly band orders; works without a browser.
 */
export function startHyperliquidHourlyHeartbeat(): void {
  const ms = getHourlyLoopMs();
  const run = () => {
    const ui = getHlUiConfig();
    if (ui.enabled === false) return;
    if (!isHyperliquidHourlyEnabled() && ui.enabled !== true) return;
    void runHyperliquidHourlyTick().catch((e) => {
      console.error('[hl-hourly]', e instanceof Error ? e.message : e);
    });
  };
  void run();
  setInterval(run, ms);
}
