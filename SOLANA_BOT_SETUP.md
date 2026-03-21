# Solana Trading Bot Setup

The SOL trading bot uses a 5-minute inside-bar pattern with breakout triggers for Jupiter Perps (short selling supported).

## Phase 1: Data + Pattern (Current)

1. **Birdeye API Key**
   - Get a key at [birdeye.so](https://birdeye.so) (or [bds.birdeye.so](https://bds.birdeye.so))
   - Add to `.env.local`:
     ```
     BIRDEYE_API_KEY=your_key_here
     ```

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
- **Execution API** - `/api/solana-bot/execute` (scaffold; full Jupiter Perps tx build in progress)

### Live Mode

1. Connect Solflare wallet
2. Switch to Live mode
3. On breakout, execution API is called; full Jupiter Perps integration (custody fetch, scaling) is WIP
4. Shorts require USDC collateral; longs use SOL
5. Jupiter Perps uses request-fulfillment (keepers execute)
