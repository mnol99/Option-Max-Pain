/**
 * Build + optionally sign+send a Jupiter Perps *market* increase (createIncreasePositionMarketRequest).
 * Shared by /api/solana-bot/execute and server-side automations.
 */

import { Connection, PublicKey, sendAndConfirmRawTransaction, Keypair } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { TransactionInstruction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  JUPITER_PERPETUALS_PROGRAM_ID,
  JUPITER_PERPETUALS_EVENT_AUTHORITY,
  JLP_POOL_ACCOUNT_PUBKEY,
  CUSTODY_SOL,
  CUSTODY_ETH,
  CUSTODY_BTC,
  CUSTODY_USDC,
  USDC_MINT,
  WETH_MINT,
  WBTC_MINT,
  getPositionPda,
  getPositionRequestPda,
  getPerpetualsPda,
} from '@/lib/solana-bot/jupiter-perps';
import { getServerTradingKeypair, isServerTradingSigningEnabled } from '@/lib/solana-bot/trading-wallet';
import type { Idl } from '@coral-xyz/anchor';
import minimalIdl from '@/lib/solana-bot/idl/jupiter-perps-minimal.json';

const USD_SCALE = 1_000_000;
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;
const WBTC_DECIMALS = 8;
const WETH_DECIMALS = 8;

export type JupiterPerpAsset = 'sol' | 'btc' | 'eth';

export interface JupiterPerpExecuteParams {
  side: 'long' | 'short';
  sizeUsd: number;
  leverage: number;
  solPrice?: number;
  btcPrice?: number;
  ethPrice?: number;
  asset: JupiterPerpAsset;
  signAndSend: boolean;
  /** When signAndSend is false: trader pubkey. When true: optional, must match server key if set. */
  owner?: string;
}

export type JupiterPerpExecuteResult =
  | { ok: true; data: { signature: string; owner: string } }
  | { ok: true; data: { serializedTx: string } }
  | { ok: false; error: string; status?: number };

function resolveOwnerAndSigner(
  signAndSend: boolean,
  ownerStr: string | undefined
): { ok: true; owner: PublicKey; serverKeypair: Keypair | null } | { ok: false; error: string; status: number } {
  if (signAndSend) {
    if (!isServerTradingSigningEnabled()) {
      return { ok: false, error: 'Server signing disabled (set SOLANA_TRADING_SERVER_SIGNING=1)', status: 403 };
    }
    let serverKeypair: Keypair;
    try {
      const k = getServerTradingKeypair();
      if (!k) {
        return {
          ok: false,
          error: 'Set SOLANA_TRADING_WALLET_KEYPAIR or SOLANA_TRADING_WALLET_SECRET_BASE64',
          status: 500,
        };
      }
      serverKeypair = k;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, status: 500 };
    }
    const owner = serverKeypair.publicKey;
    if (ownerStr && ownerStr !== owner.toBase58()) {
      return { ok: false, error: 'owner pubkey does not match server trading wallet', status: 403 };
    }
    return { ok: true, owner, serverKeypair };
  }
  if (!ownerStr) {
    return { ok: false, error: 'Invalid body: need owner (pubkey) when signAndSend is false', status: 400 };
  }
  return { ok: true, owner: new PublicKey(ownerStr), serverKeypair: null };
}

export async function jupiterPerpExecuteMarket(
  p: JupiterPerpExecuteParams
): Promise<JupiterPerpExecuteResult> {
  const {
    side,
    sizeUsd = 100,
    leverage = 1.5,
    solPrice,
    btcPrice,
    ethPrice,
    asset = 'sol',
    signAndSend = false,
  } = p;

  if (!side || (side !== 'long' && side !== 'short')) {
    return { ok: false, error: 'Invalid: need side (long|short)' };
  }

  const r = resolveOwnerAndSigner(signAndSend, p.owner);
  if (!r.ok) return r;
  const { owner, serverKeypair } = r;

  const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
  const connection = new Connection(rpcUrl);
  const provider = new AnchorProvider(
    connection,
    { publicKey: owner } as any,
    AnchorProvider.defaultOptions()
  );
  const program = new Program(minimalIdl as Idl, JUPITER_PERPETUALS_PROGRAM_ID, provider);

  const useBtc = asset === 'btc';
  const useEth = asset === 'eth';
  const custody = useEth ? CUSTODY_ETH : useBtc ? CUSTODY_BTC : CUSTODY_SOL;
  const collateralCustody =
    side === 'short' ? CUSTODY_USDC : useBtc ? CUSTODY_BTC : useEth ? CUSTODY_ETH : CUSTODY_SOL;
  const inputMint =
    side === 'short'
      ? USDC_MINT
      : useBtc
        ? WBTC_MINT
        : useEth
          ? WETH_MINT
          : NATIVE_MINT;

  const position = getPositionPda(owner, custody, collateralCustody, side);
  const counter = BigInt(Math.floor(Math.random() * 1_000_000_000));
  const positionRequest = getPositionRequestPda(position, counter);
  const fundingAccount = getAssociatedTokenAddressSync(inputMint, owner);
  const positionRequestAta = getAssociatedTokenAddressSync(inputMint, positionRequest, true);
  const perpetuals = getPerpetualsPda();

  const leverageNum = Math.max(1, Math.min(100, leverage));
  const collateralUsd = sizeUsd / leverageNum;
  const sizeUsdDelta = new BN(Math.floor(sizeUsd * USD_SCALE));

  let collateralTokenDelta: BN;
  if (side === 'short') {
    collateralTokenDelta = new BN(Math.floor(collateralUsd * Math.pow(10, USDC_DECIMALS)));
  } else if (useBtc) {
    if (!btcPrice || btcPrice <= 0) {
      return { ok: false, error: 'btcPrice required for long BTC positions' };
    }
    const collateralBtc = collateralUsd / btcPrice;
    collateralTokenDelta = new BN(Math.floor(collateralBtc * Math.pow(10, WBTC_DECIMALS)));
  } else if (useEth) {
    if (!ethPrice || ethPrice <= 0) {
      return { ok: false, error: 'ethPrice required for long ETH positions' };
    }
    const collateralWeth = collateralUsd / ethPrice;
    collateralTokenDelta = new BN(Math.floor(collateralWeth * Math.pow(10, WETH_DECIMALS)));
  } else {
    if (!solPrice || solPrice <= 0) {
      return { ok: false, error: 'solPrice required for long SOL positions' };
    }
    const collateralSol = collateralUsd / solPrice;
    collateralTokenDelta = new BN(Math.floor(collateralSol * Math.pow(10, SOL_DECIMALS)));
  }

  const priceSlippage = new BN(500);
  const preInstructions: TransactionInstruction[] = [];
  const postInstructions: TransactionInstruction[] = [];

  if (inputMint.equals(NATIVE_MINT)) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        fundingAccount,
        owner,
        NATIVE_MINT
      )
    );
    preInstructions.push(
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: fundingAccount,
        lamports: BigInt(collateralTokenDelta.toString()),
      })
    );
    preInstructions.push(createSyncNativeInstruction(fundingAccount));
    postInstructions.push(createCloseAccountInstruction(fundingAccount, owner, owner));
  } else if (inputMint.equals(WBTC_MINT) || inputMint.equals(WETH_MINT)) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        fundingAccount,
        owner,
        inputMint
      )
    );
  }

  const increaseIx = await program.methods
    .createIncreasePositionMarketRequest({
      sizeUsdDelta,
      collateralTokenDelta,
      side: side === 'long' ? { long: {} } : { short: {} },
      priceSlippage,
      jupiterMinimumOut: null,
      counter: new BN(counter.toString()),
    })
    .accounts({
      owner,
      fundingAccount,
      perpetuals,
      pool: JLP_POOL_ACCOUNT_PUBKEY,
      position,
      positionRequest,
      positionRequestAta,
      custody,
      collateralCustody,
      inputMint,
      referral: JUPITER_PERPETUALS_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      eventAuthority: JUPITER_PERPETUALS_EVENT_AUTHORITY,
      program: JUPITER_PERPETUALS_PROGRAM_ID,
    })
    .instruction();

  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
    ...preInstructions,
    increaseIx,
    ...postInstructions,
  ];

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const txMessage = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(txMessage);

  if (signAndSend && serverKeypair) {
    tx.sign([serverKeypair]);
    const raw = tx.serialize();
    const sig = await sendAndConfirmRawTransaction(connection, Buffer.from(raw), {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    return { ok: true, data: { signature: sig, owner: owner.toBase58() } };
  }
  if (signAndSend && !serverKeypair) {
    return { ok: false, error: 'signAndSend requires server keypair' };
  }
  const serialized = Buffer.from(tx.serialize()).toString('base64');
  return { ok: true, data: { serializedTx: serialized } };
}
