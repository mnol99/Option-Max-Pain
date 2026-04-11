/**
 * Background IBIT / Arkham poll on the Node server so transfer detection runs without a browser tab.
 */

import { isIbitServerPollHeartbeatEnabled, getIbitServerPollIntervalMs } from '@/lib/solana-bot/ibit-config';
import { pollIbitTransfers } from '@/lib/solana-bot/ibit-poll';

export function startIbitPollHeartbeat(): void {
  if (!isIbitServerPollHeartbeatEnabled()) return;

  const ms = getIbitServerPollIntervalMs();

  const run = async () => {
    try {
      await pollIbitTransfers();
    } catch {
      /* ignore */
    }
  };

  void run();
  setInterval(run, ms);
}
