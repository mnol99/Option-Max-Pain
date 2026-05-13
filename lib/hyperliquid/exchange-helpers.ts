import { cancel } from '@nktkas/hyperliquid/api/exchange';
import { getHyperliquidClients } from '@/lib/hyperliquid/hl-clients';
import { formatSizeForHl } from '@/lib/hyperliquid/hl-order-utils';
import { getHyperliquidPrivateKey } from '@/lib/hyperliquid/config';

export type CoinMeta = { uidx: number; szDecimals: number };

export async function getCoinMeta(coin: string): Promise<CoinMeta | null> {
  const clients = getHyperliquidClients();
  if (!clients.ok) return null;
  const m = await clients.info.meta();
  const u = coin.trim().toUpperCase();
  const uidx = m.universe.findIndex((x) => x.name === u);
  if (uidx < 0) return null;
  return { uidx, szDecimals: m.universe[uidx]!.szDecimals };
}

export async function hyperliquidCancelOrders(
  items: Array<{ coin: string; oid: number }>
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!getHyperliquidPrivateKey()) {
    return { ok: false, error: 'HL_API_PRIVATE_KEY not configured' };
  }
  const clients = getHyperliquidClients();
  if (!clients.ok) return { ok: false, error: clients.error };

  const cancels: { a: number; o: number }[] = [];
  for (const it of items) {
    const meta = await getCoinMeta(it.coin);
    if (!meta) return { ok: false, error: `Unknown perp: ${it.coin}` };
    cancels.push({ a: meta.uidx, o: it.oid });
  }

  await cancel({ transport: clients.transport, wallet: clients.wallet }, { cancels });
  return { ok: true };
}

/** Single GTC limit in base coin size (e.g. SOL amount for SOL-PERP). */
export async function hyperliquidPlaceLimitGtc(params: {
  coin: string;
  isBuy: boolean;
  limitPx: number;
  /** Base asset size (coin quantity), not USD. */
  szCoin: number;
  reduceOnly?: boolean;
}): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  if (!getHyperliquidPrivateKey()) {
    return { ok: false, error: 'HL_API_PRIVATE_KEY not configured' };
  }
  const clients = getHyperliquidClients();
  if (!clients.ok) return { ok: false, error: clients.error };

  const meta = await getCoinMeta(params.coin);
  if (!meta) return { ok: false, error: `Unknown perp: ${params.coin}` };
  const { uidx, szDecimals } = meta;
  const sz = formatSizeForHl(params.szCoin, szDecimals);
  if (Number(sz) <= 0) return { ok: false, error: 'Size rounds to zero; increase size' };

  const px = String(params.limitPx);
  const orderRes = await clients.exchange.order({
    orders: [
      {
        a: uidx,
        b: params.isBuy,
        p: px,
        s: sz,
        r: params.reduceOnly === true,
        t: { limit: { tif: 'Gtc' } },
      },
    ],
    grouping: 'na',
  });

  if (orderRes.status === 'ok' && orderRes.response?.type === 'order' && orderRes.response.data?.statuses?.[0]) {
    const st = orderRes.response.data.statuses[0];
    if (st && typeof st === 'object' && 'error' in st) {
      return { ok: false, error: String((st as { error: string }).error) };
    }
    const okLeg =
      st &&
      typeof st === 'object' &&
      ('resting' in st || 'filled' in st);
    if (!okLeg) {
      return { ok: false, error: 'Order not resting or filled (check margin / min size)' };
    }
  } else {
    return { ok: false, error: 'Unexpected order response' };
  }

  const det = `${params.coin} ${params.isBuy ? 'buy' : 'sell'} @${px} sz=${sz} GTC`;
  console.log('[hl-manual]', det);
  return { ok: true, detail: det };
}
