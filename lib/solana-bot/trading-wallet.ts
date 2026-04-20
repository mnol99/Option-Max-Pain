/**
 * Optional hot wallet for unattended Jupiter Perp txs (server signs).
 * Enable with SOLANA_TRADING_SERVER_SIGNING=1 and a key source below.
 *
 * Security: use a dedicated wallet; fund only what you risk; chmod 600 keypair file;
 * never commit secrets.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';

export function isServerTradingSigningEnabled(): boolean {
  return process.env.SOLANA_TRADING_SERVER_SIGNING === '1';
}

/**
 * Solana CLI / Phantom export: JSON array of 64 bytes in a file.
 * Env: SOLANA_TRADING_WALLET_KEYPAIR=.secrets/trader.json (relative to cwd or absolute)
 *
 * Or: SOLANA_TRADING_WALLET_SECRET_BASE64= base64-encoded 64-byte secret key.
 */
export function getServerTradingKeypair(): Keypair | null {
  if (!isServerTradingSigningEnabled()) return null;

  const fp = process.env.SOLANA_TRADING_WALLET_KEYPAIR?.trim();
  if (fp) {
    const full = path.isAbsolute(fp) ? fp : path.join(process.cwd(), fp);
    if (!fs.existsSync(full)) {
      throw new Error(`SOLANA_TRADING_WALLET_KEYPAIR file not found: ${full}`);
    }
    const raw = JSON.parse(fs.readFileSync(full, 'utf8')) as number[];
    if (!Array.isArray(raw) || raw.length < 64) {
      throw new Error('SOLANA_TRADING_WALLET_KEYPAIR: expected JSON byte array (solana-keygen format)');
    }
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }

  const b64 = process.env.SOLANA_TRADING_WALLET_SECRET_BASE64?.trim();
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 64) {
      throw new Error('SOLANA_TRADING_WALLET_SECRET_BASE64: expected at least 64 bytes');
    }
    return Keypair.fromSecretKey(new Uint8Array(buf));
  }

  return null;
}
