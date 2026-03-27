# Solana Trading Bot Setup

The SOL trading bot uses the same inside-bar pattern on **5m, 10m, or 60m** bars (separate tabs on `/trade`), with breakout triggers for Jupiter Perps (short selling supported).

## Phase 1: Data + Pattern (Current)

1. **Data source: Jupiter Perps (Doves oracle)**
   - All price and candle data comes from the Doves oracle on-chain (same feed Jupiter Perps uses for execution)
   - Uses Solana RPC (default public or set `NEXT_PUBLIC_SOLANA_RPC` / `SOLANA_RPC` in `.env.local`). **Public RPCs often return 429** if too many reads hit the same oracle account—use a **free tier from Helius, QuickNode, etc.** Doves reads are throttled in code (~5s min between fetches) with a short stale cache on 429.
   - Optional: `DOVES_MIN_FETCH_INTERVAL_MS` (default 5000), `DOVES_STALE_CACHE_MS` (default 120000).
   - Candles are built by polling Doves every 15s; first pattern available ~20 min after bot starts

2. **Run the app**
   - `npm run dev`
   - Go to [/trade](/trade)

3. **Trade window**
   - Use the **5m / 10m / 60m** strategy tabs; each has its own candles, state, trade log, and performance (default **$1,000** position per strategy in paper mode; combined paper balance default **$3,000**)
   - Paper-trade simulation: no real execution until Live mode
   - Metrics: PnL, win rate, Sharpe ratio (per tab)

## Pattern Rules

- **Detection:** Inside bar (contained within prior) + smallest of past 3 ranges
- **Long trigger:** Price breaks above inside bar high
- **Short trigger:** Price breaks below inside bar low
- **TP:** Entry ± range (high + range for long, low - range for short)
- **Stop & reverse:** Opposite level break; max 2 stop events per setup
- **Time exit:** Window ends at **pattern candle close + 2× bar length** (not from entry time). E.g. 60m pattern that closes at 21:00 UTC → window ends 23:00 UTC even if you enter at 21:25. After that window, the bot is idle and can detect the next pattern (including an inside bar on the next period).

## Phase 2 (Current)

- **Solflare wallet** - Connect via wallet adapter (mainnet)
- **Paper / Live mode** - Toggle when connected
- **Execution API** - `/api/solana-bot/execute` builds createIncreasePositionMarketRequest tx
- **Minimal IDL** - `jupiter-perps-minimal.json` (Anchor 0.29 compatible)
- **Jupiter Perps helpers** - `lib/solana-bot/jupiter-perps.ts` (PDAs, custody consts)

### Live Mode

1. Connect Solflare wallet
2. Switch to Live mode
3. On breakout, execution API is called (market order)
4. Shorts require USDC collateral; longs use SOL
5. Jupiter Perps uses request-fulfillment (keepers execute)
6. **Tx build:** Uses minimal IDL + Anchor 0.29; returns serialized tx for Solflare to sign & send

## Backtest (Optimization)

- **Route:** [/backtest](/backtest)
- **Requires:** `BIRDEYE_API_KEY` in `.env.local` (historical OHLCV)
- **Analyzes:** Past 1–24 hours (default 6h) of 5m SOL candles
- **Metrics:** Patterns detected vs missed, win rate, PnL %, avg slippage (bps), MAE/MFE
- Use to verify pattern detection coverage and tune parameters
