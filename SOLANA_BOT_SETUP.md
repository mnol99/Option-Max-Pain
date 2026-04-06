# Solana Trading Bot Setup

The SOL trading bot uses the same inside-bar pattern on **60m** and **Daily (ET calendar day)** bars (separate tabs on `/trade`), plus **BLK** for IBIT paper simulation. Breakout triggers target Jupiter Perps (short selling supported). **Daily** candles: **open 8:00 PM ET**, **close 7:59:59 PM ET** the next calendar day (23h 59m 59s bar); next bar opens at **8:00 PM ET** again. DST is handled via the same ET→UTC conversion as the rest of the app. **60m** is halted Fri **5:00pm** ET → Sun **3:00pm** ET (no new signals; open positions flatten at market); **Daily** runs through the weekend.

## Phase 1: Data + Pattern (Current)

1. **Data source: Jupiter Perps (Doves oracle)**
   - All price and candle data comes from the Doves oracle on-chain (same feed Jupiter Perps uses for execution)
   - Uses Solana RPC (default public or set `NEXT_PUBLIC_SOLANA_RPC` / `SOLANA_RPC` in `.env.local`). **Public RPCs often return 429** if too many reads hit the same oracle account—use a **free tier from Helius, QuickNode, etc.** Doves reads are throttled in code (~5s min between fetches) with a short stale cache on 429.
   - Optional: `DOVES_MIN_FETCH_INTERVAL_MS` (default 5000), `DOVES_STALE_CACHE_MS` (default 120000).
   - **IBIT / BLK:** `IBIT_SIGNAL_MAX_AGE_SEC` — max age (seconds) of **on-chain block time** for a transfer to qualify (default **7200** = 2 hours). Prevents a morning transfer from re-firing hours later on refresh. Raise (e.g. `43200`) if the bot sleeps past that window and you still want same-day signals. Processed txids are deduped in **localStorage**, **`.data/blk-processed-txids.json`** (server), and synced from the BLK trade log on load. Optional **`BLK_PROCESSED_TXIDS_PATH`** overrides the server file path. Set `0` to disable the age check (not recommended). Ignored when `IBIT_ALLOW_HISTORICAL_SIGNALS=1`. Optional **Arkham Intel**: set `ARKHAM_API_KEY` in `.env.local` (never commit). The server calls `GET https://api.arkm.com/transfers` with `base` = `ARKHAM_TRANSFER_BASE` (default `blackrock` — confirm entity slug in Arkham), `chains=bitcoin`, `flow=out`, `timeLast` (default `7d`), then fetches each `transactionHash` from Blockstream and applies the same size/time filters as other paths. Disable with `ARKHAM_DISABLE_IBIT_POLL=1`. Detection **polls Coinbase deposit addresses first** (recent txs per address; large ~200+ BTC to the main output → signal). **Sender addresses** are taken from transaction inputs (largest prevout = “primary feeder”) for audit and pattern review; optional legacy custodian list overlap is flagged as `watchListMatch`. `IBIT_EXTRA_TXIDS` still forces evaluation of specific txids. Signals must be on **today’s ET calendar day** (same clock time on an old date no longer fires). Set `IBIT_ALLOW_HISTORICAL_SIGNALS=1` only to replay past txs for testing. Optional: `IBIT_POLL_SOURCE_WATCH=1` to also poll legacy `IBIT_BTC_WATCH_ADDRESSES`; `IBIT_COINBASE_TX_LIMIT` (default 50) for how many recent txs to pull per Coinbase address. Daytime transfers **≥10:00 ET** use **6 covers 3:00–3:50pm ET** (paper sim); earlier signals use **18 covers 10:00–12:50 ET**.
   - Candles: 60m UTC-hour bars; Daily = ET day bars (see above). First pattern needs 4 completed bars (Daily can take several days of uptime).

2. **Run the app**
   - `npm run dev`
   - Go to [/trade](/trade)

3. **Trade window**
   - Use the **60m**, **Daily**, **ETH 60m**, **ETH Daily**, **BTC 60m**, **BTC Daily**, and **BLK** tabs; each has its own candles, state, trade log, and performance (default **$1,000** position per strategy in paper mode; combined paper balance default **$3,000**). SOL uses **Doves** candles; **BTC** and **ETH** use **Pyth** USD marks for OHLC. In **paper** mode, inside-bar simulation also runs **on the server** (POST `/api/solana-bot/inside-bar/tick` every few seconds plus a background heartbeat). **Live** auto-execution: **SOL** and **WBTC** perps only; ETH tabs are paper until execution is wired.
   - **Dev restarts:** `npm run dev` restart used to wipe the server’s in-memory candle buffers, so the UI showed **warmup** again (need 4 completed bars). In **development** (`NODE_ENV=development`), completed + in-progress candles are now saved under **`.data/inside-bar-candles.json`** (gitignored) and reloaded on boot. Set **`INSIDE_BAR_DISABLE_CANDLE_PERSIST=1`** to disable that file. Optional override: **`INSIDE_BAR_CANDLES_PERSIST_PATH`** (absolute or relative path). Production builds do not persist unless you set `INSIDE_BAR_CANDLES_PERSIST_PATH`.
   - **Warmup without waiting:** If **`BIRDEYE_API_KEY`** is set in `.env.local`, the server can **backfill** the last **4 closed** 60m candles and **4 ET daily** bars (from hourly Birdeye data, or Birdeye **`1D`** candles mapped to the 8pm ET session when hourly aggregation is insufficient — e.g. BTC Daily). Live prices still use **Doves / Pyth**. Disable with **`INSIDE_BAR_DISABLE_BIRDEYE_BACKFILL=1`**. **ETH:** tries multiple WETH mints; if **1h** is empty, **5m** bars are aggregated to UTC hours; override mints with **`BIRDEYE_ETH_MINT`** or **`BIRDEYE_ETH_MINTS`** if needed.
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
