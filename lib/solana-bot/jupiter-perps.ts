/**
 * Jupiter Perps constants and PDA helpers
 */
import { PublicKey } from '@solana/web3.js';

export const JUPITER_PERPETUALS_PROGRAM_ID = new PublicKey(
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'
);

export const JUPITER_PERPETUALS_EVENT_AUTHORITY = new PublicKey(
  '37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN'
);

export const JLP_POOL_ACCOUNT_PUBKEY = new PublicKey(
  '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq'
);

export const CUSTODY_SOL = new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz');
export const CUSTODY_BTC = new PublicKey('5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm');
export const CUSTODY_USDC = new PublicKey('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa');
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
/** WBTC mint used by Jupiter BTC custody */
export const WBTC_MINT = new PublicKey('3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh');

export function getPositionPda(
  owner: PublicKey,
  custody: PublicKey,
  collateralCustody: PublicKey,
  side: 'long' | 'short'
): PublicKey {
  const [position] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('position'),
      owner.toBuffer(),
      JLP_POOL_ACCOUNT_PUBKEY.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
      Buffer.from([side === 'long' ? 1 : 2]),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID
  );
  return position;
}

export function getPositionRequestPda(
  position: PublicKey,
  counter: bigint
): PublicKey {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64LE(counter);
  const [positionRequest] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('position_request'),
      position.toBuffer(),
      counterBuf,
      Buffer.from([1]),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID
  );
  return positionRequest;
}

export function getPerpetualsPda(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('perpetuals')],
    JUPITER_PERPETUALS_PROGRAM_ID
  );
  return pda;
}
