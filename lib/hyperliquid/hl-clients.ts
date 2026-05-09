import { ExchangeClient, HttpTransport, InfoClient, type HttpTransportOptions } from '@nktkas/hyperliquid';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { getHyperliquidPrivateKey, getHyperliquidTestnet } from '@/lib/hyperliquid/config';

function transportOpts(): HttpTransportOptions {
  return { isTestnet: getHyperliquidTestnet() };
}

let cached: {
  transport: HttpTransport;
  info: InfoClient;
  exchange: ExchangeClient;
  wallet: PrivateKeyAccount;
} | null = null;

export function getHyperliquidClients():
  | {
      ok: true;
      transport: HttpTransport;
      info: InfoClient;
      exchange: ExchangeClient;
      wallet: PrivateKeyAccount;
    }
  | { ok: false; error: string } {
  const pk = getHyperliquidPrivateKey();
  if (!pk) {
    return { ok: false, error: 'Set HL_API_PRIVATE_KEY (0x-prefixed EVM private key) in .env.local' };
  }
  if (cached) {
    return {
      ok: true,
      transport: cached.transport,
      info: cached.info,
      exchange: cached.exchange,
      wallet: cached.wallet,
    };
  }
  const transport = new HttpTransport(transportOpts());
  const info = new InfoClient({ transport });
  const wallet = privateKeyToAccount(pk);
  const exchange = new ExchangeClient({ transport, wallet });
  cached = { transport, info, exchange, wallet };
  return { ok: true, transport, info, exchange, wallet };
}

export function clearHyperliquidClientsCache(): void {
  cached = null;
}
