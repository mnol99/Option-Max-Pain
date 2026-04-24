import { getHyperliquidClients } from '@/lib/hyperliquid/hl-clients';
import {
  getBlkHyperliquidCoin,
  getBlkHyperliquidIsolated,
  getHourlyCrossMargin,
  getHyperliquidUserAddress,
} from '@/lib/hyperliquid/config';
import { formatSizeForHl } from '@/lib/hyperliquid/hl-order-utils';

export type HlBlkExecuteResult =
  | { ok: true; detail: string }
  | { ok: false; error: string; status?: number };

/**
 * Market-style IOC perp order for BLK (session open and cover slices).
 * `notionalUsd` is position notional; leverage sets cross/isolated perp margin on this asset.
 */
export async function executeHyperliquidBlkMarket(params: {
  side: 'long' | 'short';
  notionalUsd: number;
  leverage: number;
  reduceOnly?: boolean;
}): Promise<HlBlkExecuteResult> {
  const { side, notionalUsd, reduceOnly = false } = params;
  let { leverage } = params;

  if (!(notionalUsd > 0)) {
    return { ok: false, error: 'notionalUsd must be positive' };
  }
  if (!(leverage >= 1)) {
    return { ok: false, error: 'leverage must be >= 1' };
  }

  const clients = getHyperliquidClients();
  if (!clients.ok) {
    return { ok: false, error: clients.error, status: 503 };
  }
  const { info, exchange } = clients;

  const coin = getBlkHyperliquidCoin();
  const isCross = getBlkHyperliquidIsolated() ? false : getHourlyCrossMargin();

  try {
    const m = await info.meta();
    const uidx = m.universe.findIndex((u) => u.name === coin);
    if (uidx < 0) {
      return { ok: false, error: `Unknown perp: ${coin} (set BLK_HL_COIN)` };
    }
    const szDec = m.universe[uidx]!.szDecimals;
    const maxLev = m.universe[uidx]!.maxLeverage;
    const useLev = Math.min(maxLev, Math.max(1, Math.round(leverage)));

    const assetCtxs = (await info.metaAndAssetCtxs())[1];
    const markStr = assetCtxs[uidx]?.markPx;
    if (!markStr) {
      return { ok: false, error: 'Could not read mark price' };
    }
    const mark = Number(markStr);
    if (!(mark > 0)) {
      return { ok: false, error: 'Invalid mark' };
    }

    const rawSz = notionalUsd / mark;
    const sz = formatSizeForHl(rawSz, szDec);
    if (Number(sz) <= 0) {
      return { ok: false, error: 'Order size is zero; raise notional' };
    }

    await exchange.updateLeverage({ asset: uidx, isCross, leverage: useLev });

    const isBuy = side === 'long';
    const slip = 0.0015; // 15 bps past mark for IOC fill
    const p = isBuy
      ? String(Math.ceil(mark * (1 + slip) * 1e6) / 1e6)
      : String(Math.floor(mark * (1 - slip) * 1e6) / 1e6);

    const orderRes = await exchange.order({
      orders: [
        {
          a: uidx,
          b: isBuy,
          p,
          s: sz,
          r: reduceOnly,
          t: { limit: { tif: 'Ioc' } },
        },
      ],
      grouping: 'na',
    });

    if (orderRes.status === 'ok' && orderRes.response?.data?.statuses) {
      for (const s of orderRes.response.data.statuses) {
        if (s && typeof s === 'object' && 'error' in s) {
          return { ok: false, error: String((s as { error: string }).error) };
        }
      }
    } else {
      return { ok: false, error: 'HL order: unexpected response' };
    }

    const user = getHyperliquidUserAddress() ?? clients.wallet.address;
    const det = `BLK ${coin} ${side} ~$${notionalUsd.toFixed(2)} notional @~${mark.toFixed(2)} sz=${sz} lev=${useLev}× r=${reduceOnly} user=${user}`;
    console.log('[hl-blk]', det);
    return { ok: true, detail: det };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
