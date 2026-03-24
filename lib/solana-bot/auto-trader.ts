/**
 * Automated trading bot - runs server-side when enabled.
 * Polls candles, detects patterns, executes on breakout, manages exits.
 * Requires TRADING_ENABLED=true, TRADING_PRIVATE_KEY (base58), and config env vars.
 */

import { Keypair } from '@solana/web3.js';
import { detectPattern, isBreakoutLong, isBreakoutShort } from './pattern-engine';
import {
  createInitialState,
  createPatternDetectedState,
  enterLong,
  enterShort,
  checkPositionExit,
  checkReversedExit,
} from './trade-state';
import type { TradeState } from './types';
import { getCandles } from './candle-aggregator';
import { fetchDovesPrice } from './doves-oracle';

const POLL_MS = 200;
const ENTRY_DELAY_MS = 5000; // Don't enter in first 5s after pattern (let candle settle)

let running = false;
let stopRequested = false;
let lastState: TradeState = createInitialState();
let lastError: string | null = null;

export function isAutoTraderRunning(): boolean {
  return running;
}

export function getAutoTraderState(): { state: TradeState; error: string | null } {
  return { state: lastState, error: lastError };
}

export function stopAutoTrader(): void {
  stopRequested = true;
}

function getConfig() {
  const enabled = process.env.TRADING_ENABLED === 'true';
  const key = process.env.TRADING_PRIVATE_KEY;
  const amount = Number(process.env.TRADING_AMOUNT_USD || 1000);
  const lev = Number(process.env.TRADING_LEVERAGE || 1.5);
  const owner = key ? Keypair.fromSecretKey(Buffer.from(key, 'base64')).publicKey.toString() : null;
  return { enabled, key, amount, lev, owner };
}

/** Base URL for API calls - use localhost when bot runs same process as Next server */
function getBaseUrl(): string {
  return process.env.TRADING_API_BASE_URL || 'http://127.0.0.1:3000';
}

async function executeEntry(side: 'long' | 'short', solPrice: number, owner: string): Promise<boolean> {
  const url = `${getBaseUrl()}/api/solana-bot/execute`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        side,
        owner,
        sizeUsd: Number(process.env.TRADING_AMOUNT_USD || 1000),
        leverage: Number(process.env.TRADING_LEVERAGE || 1.5),
        solPrice: side === 'long' ? solPrice : undefined,
        autoSign: true,
      }),
    });
    const json = await res.json();
    if (json.success) return true;
    lastError = json.error || 'Execute failed';
    return false;
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'Execute failed';
    return false;
  }
}

async function executeClose(): Promise<boolean> {
  const url = `${getBaseUrl()}/api/solana-bot/close`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoSign: true }),
    });
    const json = await res.json();
    if (json.success) return true;
    lastError = json.error || 'Close failed';
    return false;
  } catch (e) {
    lastError = e instanceof Error ? e.message : 'Close failed';
    return false;
  }
}

export async function runAutoTrader(): Promise<void> {
  const { enabled, key } = getConfig();
  if (!enabled || !key) return;

  const keypair = Keypair.fromSecretKey(Buffer.from(key, 'base64'));
  const owner = keypair.publicKey.toString();

  running = true;
  stopRequested = false;
  lastError = null;
  lastState = createInitialState();

  let patternDetectedAt = 0;
  let breakoutConfirmCount = { long: 0, short: 0 };
  let entering = false;

  const tick = async () => {
    if (stopRequested) {
      running = false;
      return;
    }

    try {
      const candles = getCandles();
      const now = Math.floor(Date.now() / 1000);

      if (candles.length >= 4 && (lastState.status === 'idle' || lastState.status === 'stopped' || lastState.status === 'pattern_detected')) {
        const setup = detectPattern(candles);
        if (setup) {
          if (setup.candleUnixTime === lastState.lastTradedCandleUnixTime) {
            // skip - we already traded this candle
          } else {
            const isDoubleInside = lastState.status === 'pattern_detected' && lastState.setup && lastState.setup.candleUnixTime !== setup.candleUnixTime;
            lastState = {
              ...createPatternDetectedState(setup),
              lastTradedCandleUnixTime: lastState.lastTradedCandleUnixTime,
            };
            if (isDoubleInside) breakoutConfirmCount = { long: 0, short: 0 };
            patternDetectedAt = Date.now();
          }
        }
      }

      if (lastState.status === 'pattern_detected' && lastState.setup && !entering) {
        const { price } = await fetchDovesPrice();
        const setup = lastState.setup;
        const longBreakout = isBreakoutLong(price, setup);
        const shortBreakout = isBreakoutShort(price, setup);

        if (Date.now() - patternDetectedAt < ENTRY_DELAY_MS) {
          breakoutConfirmCount = { long: 0, short: 0 };
        } else if (longBreakout) {
          breakoutConfirmCount = { long: breakoutConfirmCount.long + 1, short: 0 };
          if (breakoutConfirmCount.long >= 1) {
            entering = true;
            breakoutConfirmCount = { long: 0, short: 0 };
            lastState = enterLong(lastState, price, now);
            const ok = await executeEntry('long', price, owner);
            if (!ok) lastState = { ...lastState, status: 'idle', position: null, setup: null, entryPrice: null, entryTime: null, windowEnd: null };
            entering = false;
          }
        } else if (shortBreakout) {
          breakoutConfirmCount = { short: breakoutConfirmCount.short + 1, long: 0 };
          if (breakoutConfirmCount.short >= 1) {
            entering = true;
            breakoutConfirmCount = { long: 0, short: 0 };
            lastState = enterShort(lastState, price, now);
            const ok = await executeEntry('short', price, owner);
            if (!ok) lastState = { ...lastState, status: 'idle', position: null, setup: null, entryPrice: null, entryTime: null, windowEnd: null };
            entering = false;
          }
        } else {
          breakoutConfirmCount = { long: 0, short: 0 };
        }
      }

      if (lastState.status === 'in_position' || lastState.status === 'reversed') {
        const { price } = await fetchDovesPrice();
        const handler = lastState.status === 'in_position' ? checkPositionExit : checkReversedExit;
        const { newState, closedTrade } = handler(lastState, price, now);
        const prevStatus = lastState.status;
        lastState = newState;

        if (newState.status === 'reversed' && prevStatus === 'in_position') {
          await executeClose();
          if (newState.position) await executeEntry(newState.position, price, owner);
          entering = false;
        } else if (closedTrade && (newState.status === 'idle' || newState.status === 'stopped')) {
          await executeClose();
          entering = false;
        }
      }

      if ((lastState.status === 'idle' || lastState.status === 'stopped') && entering) {
        entering = false;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  };

  // Delay so Next server is listening before we call API
  setTimeout(() => {
    if (stopRequested) return;
    tick();
    setInterval(tick, POLL_MS);
  }, 10_000);
}

export function isAutoTraderEnabled(): boolean {
  return process.env.TRADING_ENABLED === 'true' && !!process.env.TRADING_PRIVATE_KEY;
}
