import { HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import {
  getHourlyAfterMinute,
  getHourlyCancelPriorBands,
  getHourlyCoin,
  getHourlyCollateralUsd,
  getHourlyLeverage,
  getHyperliquidPrivateKey,
  getHyperliquidTestnet,
  getHyperliquidUserAddress,
  isHyperliquidHourlyEnabled,
} from '@/lib/hyperliquid/config';
import { getHourlyStateSnapshot } from '@/lib/hyperliquid/hourly-bands';
import { getHlUiConfig } from '@/lib/hyperliquid/ui-config';

/**
 * Public snapshot for /api/hyperliquid (no private key; read-only info).
 */
export async function getHyperliquidDashboardData(): Promise<{
  hasKey: boolean;
  user: `0x${string}` | null;
  testnet: boolean;
  envHourlyEnabled: boolean;
  /** When true, each hour cancels open limits on the symbol before new bands (opt-in). */
  envHourlyCancelPriorBands: boolean;
  config: {
    coin: string;
    collateralUsd: number;
    leverage: number;
    afterMinute: number;
    notionalUsd: number;
  };
  hourly: ReturnType<typeof getHourlyStateSnapshot>;
  openOrders: Array<{
    coin: string;
    side: string;
    limitPx: string;
    sz: string;
    oid: number;
  }>;
  recentFills: Array<{
    coin: string;
    side: string;
    px: string;
    sz: string;
    time: number;
    closedPnl: string;
    fee: string;
  }>;
  margin?: { accountValue: string; withdrawable: string; totalNtlPos: string };
  error?: string;
}> {
  const ui = getHlUiConfig();
  const coin = ui.coin?.trim().toUpperCase() || getHourlyCoin();
  const collateral = ui.collateralUsd ?? getHourlyCollateralUsd();
  const lev = ui.leverage ?? getHourlyLeverage();
  const afterMin = ui.afterMinute ?? getHourlyAfterMinute();

  const st = getHourlyStateSnapshot();
  const hasKey = getHyperliquidPrivateKey() != null;
  const user = getHyperliquidUserAddress();
  if (!hasKey) {
    return {
      hasKey: false,
      user: user ?? null,
      testnet: getHyperliquidTestnet(),
      envHourlyEnabled: isHyperliquidHourlyEnabled(),
      envHourlyCancelPriorBands: getHourlyCancelPriorBands(),
      config: { coin, collateralUsd: collateral, leverage: lev, afterMinute: afterMin, notionalUsd: collateral * lev },
      hourly: st,
      openOrders: [],
      recentFills: [],
    };
  }
  const transport = new HttpTransport({ isTestnet: getHyperliquidTestnet() });
  const info = new InfoClient({ transport });
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const w = getHyperliquidPrivateKey()!;
    const acct = privateKeyToAccount(w);
    const addr = user ?? acct.address;
    const [open, fills, ch] = await Promise.all([
      info.frontendOpenOrders({ user: addr, dex: '' }),
      info.userFills({ user: addr }),
      info.clearinghouseState({ user: addr }),
    ]);
    const recent = [...fills]
      .sort((a, b) => b.time - a.time)
      .slice(0, 30)
      .map((f) => ({
        coin: f.coin,
        side: f.side,
        px: f.px,
        sz: f.sz,
        time: f.time,
        closedPnl: f.closedPnl,
        fee: f.fee,
      }));
    return {
      hasKey: true,
      user: addr,
      testnet: getHyperliquidTestnet(),
      envHourlyEnabled: isHyperliquidHourlyEnabled(),
      envHourlyCancelPriorBands: getHourlyCancelPriorBands(),
      config: { coin, collateralUsd: collateral, leverage: lev, afterMinute: afterMin, notionalUsd: collateral * lev },
      hourly: st,
      openOrders: open.map((o) => ({
        coin: o.coin,
        side: o.side,
        limitPx: o.limitPx,
        sz: o.sz,
        oid: o.oid,
      })),
      recentFills: recent.slice(0, 25),
      margin: {
        accountValue: ch.marginSummary.accountValue,
        withdrawable: ch.withdrawable,
        totalNtlPos: ch.marginSummary.totalNtlPos,
      },
    };
  } catch (e) {
    return {
      hasKey: true,
      user: user ?? null,
      testnet: getHyperliquidTestnet(),
      envHourlyEnabled: isHyperliquidHourlyEnabled(),
      envHourlyCancelPriorBands: getHourlyCancelPriorBands(),
      config: { coin, collateralUsd: collateral, leverage: lev, afterMinute: afterMin, notionalUsd: collateral * lev },
      hourly: st,
      openOrders: [],
      recentFills: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
