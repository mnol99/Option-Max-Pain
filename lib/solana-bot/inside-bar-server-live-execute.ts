/**
 * When INSIDE_BAR_SERVER_LIVE_EXECUTE=1 and server wallet is configured, run Jupiter market
 * increases for inside-bar *entries* in the same process as the server tick (VPS, no browser).
 */

import { jupiterPerpExecuteMarket } from '@/lib/solana-bot/jupiter-perp-execute';
import { isServerTradingSigningEnabled } from '@/lib/solana-bot/trading-wallet';
import { INSIDE_BAR_STRATEGIES, strategyUnderlying } from '@/lib/solana-bot/strategy-tabs';
import type { TradeState } from '@/lib/solana-bot/types';

export function isInsideBarServerLiveExecuteEnabled(): boolean {
  return process.env.INSIDE_BAR_SERVER_LIVE_EXECUTE === '1';
}

function priceByUnderlying(
  u: 'sol' | 'btc' | 'eth',
  p: { sol: number; btc: number; eth: number }
): number {
  return u === 'sol' ? p.sol : u === 'btc' ? p.btc : p.eth;
}

/**
 * After `runInsideBarStep`, if we transitioned to `in_position` from `pattern_detected`, submit
 * a signed Jupiter increase (idempotent w.r.t. state — on-chain is separate; retry must be off-chain).
 */
export function queueInsideBarLiveExecutions(
  before: Record<string, TradeState>,
  after: Record<string, TradeState>,
  sizeUsd: number,
  leverage: number,
  marks: { sol: number; btc: number; eth: number }
): void {
  if (!isInsideBarServerLiveExecuteEnabled() || !isServerTradingSigningEnabled()) return;
  if (sizeUsd <= 0) return;
  for (const s of INSIDE_BAR_STRATEGIES) {
    const sid = s.id;
    const prev = before[sid];
    const st = after[sid];
    if (!prev || !st) continue;
    if (prev.status !== 'pattern_detected' || st.status !== 'in_position') continue;
    if (st.position !== 'long' && st.position !== 'short') continue;
    if (st.entryPrice == null) continue;
    const u = strategyUnderlying(s);
    const mark = priceByUnderlying(u, marks);
    if (!(mark > 0)) {
      /* Pyth miss for this asset on this tick — do not log every time */
      continue;
    }
    const entry = st.entryPrice;
    const side = st.position;
    void (async () => {
      try {
        const r = await jupiterPerpExecuteMarket({
          side,
          sizeUsd,
          leverage: Math.max(1, Math.min(100, leverage)),
          solPrice: u === 'sol' ? mark : undefined,
          btcPrice: u === 'btc' ? mark : undefined,
          ethPrice: u === 'eth' ? mark : undefined,
          asset: u,
          signAndSend: true,
        });
        if (r.ok && 'signature' in r.data) {
          console.log(
            `[inside-bar-live] ${sid} ${side} entry=${entry.toFixed(4)} sig=${r.data.signature.slice(0, 12)}…`
          );
        } else if (!r.ok) {
          console.error(`[inside-bar-live] ${sid} ${side} failed: ${r.error}`);
        }
      } catch (e) {
        console.error(
          `[inside-bar-live] ${sid} ${side}`,
          e instanceof Error ? e.message : e
        );
      }
    })();
  }
}
