/**
 * Shared IBIT / BLK signal types (avoids circular imports between ibit-poll and ibit-arkham-batch).
 */

export interface IbitTransferSignal {
  txid: string;
  blockTime: number;
  sourceAddress: string;
  inputSourceAddresses: string[];
  watchListMatch: boolean;
  signalSource: 'coinbase_deposit' | 'source_watch' | 'extra_txid' | 'arkham';
  arkhamEntityBase?: string;
  sats: number;
  mainOutSats: number;
  mainOutBtc: number;
  matchedDestinations: string[];
  coverScheduleUtc: string[];
  detectionMode: 'strict' | 'legacy';
  /** Arkham batch mode: which rule fired */
  blkArkhamBatchRole?: 'second_out_short' | 'second_in_long' | 'second_striker_in_long';
  /** Arkham-reported unit BTC (hint for audit) */
  arkhamUnitBtc?: number;
}

export interface IbitBatchGroup {
  blockTime: number;
  txids: string[];
}
