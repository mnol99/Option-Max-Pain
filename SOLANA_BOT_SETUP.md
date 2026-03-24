# Solana Trading Bot Setup

The SOL trading bot uses a 5-minute inside-bar pattern with breakout triggers for Jupiter Perps (short selling supported).

## Phase 1: Data + Pattern (Current)

1. **Data source: Jupiter Perps (Doves oracle)**
   - All price and candle data comes from the Doves oracle on-chain (same feed Jupiter Perps uses for execution)
   - No API keys needed for data; uses Solana RPC (default public or set `NEXT_PUBLIC_SOLANA_RPC` / `SOLANA_RPC` in `.env.local`)
   - Candles are built by polling Doves every 5s; first pattern available ~20 min after bot starts

2. **Run the app**
   - `npm run dev`
   - Go to [/trade](/trade)

3. **Trade window**
   - Pattern detection runs automatically on 5m SOL candles
   - Paper-trade simulation: no real execution yet
   - Metrics: PnL, win rate, Sharpe ratio

## Pattern Rules

- **Detection:** Inside bar (contained within prior) + smallest of past 3 ranges
- **Long trigger:** Price breaks above inside bar high
- **Short trigger:** Price breaks below inside bar low
- **TP:** Entry ± range (high + range for long, low - range for short)
- **Stop & reverse:** Opposite level break; max 2 stop events per setup
- **Time exit:** 5 minutes from entry if TP/stop not hit

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

### Resting Limit Orders (Faster Entry)

Jupiter Perps does not expose a user-callable on-chain instruction to place resting limit orders for **opening** positions. The `instantCreateLimitOrder` instruction requires keeper signatures. For faster entry (less slippage vs breakout level):

1. When a pattern is detected in Live mode, the bot shows **Place resting limit order (optional)** with links to Jupiter Perps
2. Click **Long SOL** or **Short SOL** to open Jupiter in a new tab
3. On Jupiter: switch to Limit order, set trigger price to the breakout level (Long &gt; high, Short &lt; low)
4. Place the order—it will execute when price hits, typically with better fills than market
5. The bot also sends market orders when it detects a breakout; you can use one or both

## Backtest (Optimization)

- **Route:** [/backtest](/backtest)
- **Requires:** `BIRDEYE_API_KEY` in `.env.local` (historical OHLCV)
- **Analyzes:** Past 1–24 hours (default 6h) of 5m SOL candles
- **Metrics:** Patterns detected vs missed, win rate, PnL %, avg slippage (bps), MAE/MFE
- Use to verify pattern detection coverage and tune parameters
