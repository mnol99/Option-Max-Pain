/**
 * When INSIDE_BAR_SERVER_LIVE_EXECUTE=1 and server wallet is configured, run Jupiter market
 * increases for inside-bar *entries* and *decreases* for exits in the same process as the server tick
 * (VPS, no browser). Exits are submitted on TP / time / stop / reverse; **closes** run before a same-tick
 * re-entry (reverse) so the book updates in order.
 */

import { jupiterPerpExecuteMarket, jupiterPerpDecreaseEntire } from '@/lib/solana-bot/jupiter-perp-execute';
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

function needsJupiterFullClose(
  prev: TradeState,
  st: TradeState
): { close: 'long' | 'short' } | null {
  if (prev.status !== 'in_position' && prev.status !== 'reversed') return null;
  if (prev.position !== 'long' && prev.position !== 'short') return null;

  if (st.status === 'idle' || st.status === 'stopped') {
    return { close: prev.position };
  }
  if (prev.status === 'in_position' && st.status === 'reversed') {
    return { close: prev.position };
  }
  return null;
}

/**
 * After `runInsideBarStep`, submit Jupiter: first full closes, then new entries. Same-tick close+open
 * (reverse) is ordered so the close is sent before the open.
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
  const lev = Math.max(1, Math.min(100, leverage));
  void (async () => {
    for (const s of INSIDE_BAR_STRATEGIES) {
      const sid = s.id;
      const prev = before[sid];
      const st = after[sid];
      if (!prev || !st) continue;
      const u = strategyUnderlying(s);
      const mark = priceByUnderlying(u, marks);
      if (!(mark > 0)) continue;

      const closePlan = needsJupiterFullClose(prev, st);
      let closeOk = true;
      if (closePlan) {
        const side = closePlan.close;
        try {
          const r = await jupiterPerpDecreaseEntire({
            side,
            sizeUsd,
            leverage: lev,
            solPrice: u === 'sol' ? mark : undefined,
            btcPrice: u === 'btc' ? mark : undefined,
            ethPrice: u === 'eth' ? mark : undefined,
            asset: u,
            signAndSend: true,
          });
          if (r.ok && 'signature' in r.data) {
            console.log(
              `[inside-bar-live] ${sid} close ${side} sig=${r.data.signature.slice(0, 12)}…`
            );
          } else {
            closeOk = false;
            console.error(
              `[inside-bar-live] ${sid} close ${side} failed: ${!r.ok ? r.error : 'unknown'}`
            );
          }
        } catch (e) {
          closeOk = false;
          console.error(
            `[inside-bar-live] ${sid} close ${side}`,
            e instanceof Error ? e.message : e
          );
        }
      }

      const fromPattern =
        prev.status === 'pattern_detected' && st.status === 'in_position' && st.entryPrice != null;
      const fromReverse =
        prev.status === 'in_position' && st.status === 'reversed' && st.entryPrice != null;
      if (!fromPattern && !fromReverse) continue;
      if (closePlan && !closeOk && fromReverse) {
        /* Do not add a second leg if the first did not close (would stack risk). */
        continue;
      }
      if (st.position !== 'long' && st.position !== 'short') continue;
      const entry = st.entryPrice;
      if (entry == null) continue;
      if (!(mark > 0)) continue;
      const side = st.position;
      try {
        const r = await jupiterPerpExecuteMarket({
          side,
          sizeUsd,
          leverage: lev,
          solPrice: u === 'sol' ? mark : undefined,
          btcPrice: u === 'btc' ? mark : undefined,
          ethPrice: u === 'eth' ? mark : undefined,
          asset: u,
          signAndSend: true,
        });
        if (r.ok && 'signature' in r.data) {
          const tag = fromReverse ? 'reversal' : 'entry';
          console.log(
            `[inside-bar-live] ${sid} ${tag} ${side} @${entry.toFixed(4)} sig=${r.data.signature.slice(0, 12)}…`
          );
        } else if (!r.ok) {
          console.error(`[inside-bar-live] ${sid} open ${side} failed: ${r.error}`);
        }
      } catch (e) {
        console.error(
          `[inside-bar-live] ${sid} open ${side}`,
          e instanceof Error ? e.message : e
        );
      }
    }
  })();
}
