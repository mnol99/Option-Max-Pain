/**
 * Close Jupiter Perps position - createDecreasePositionMarketRequest
 * When autoSign=true, signs and sends server-side.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from '@solana/spl-token';
import {
  JUPITER_PERPETUALS_PROGRAM_ID,
  JUPITER_PERPETUALS_EVENT_AUTHORITY,
  JLP_POOL_ACCOUNT_PUBKEY,
  CUSTODY_SOL,
  CUSTODY_USDC,
  USDC_MINT,
  getPositionPda,
  getPositionRequestPda,
  getPerpetualsPda,
} from '@/lib/solana-bot/jupiter-perps';

import type { Idl } from '@coral-xyz/anchor';
import perpsIdl from '@/lib/solana-bot/idl/jupiter-perps-minimal.json';

const USD_SCALE = 1_000_000;
const POSITION_DISCRIMINATOR_LEN = 8;
const POSITION_OWNER_LEN = 32;
const POSITION_POOL_LEN = 32;
const POSITION_CUSTODY_LEN = 32;
const POSITION_COLLATERAL_LEN = 32;
const POSITION_OPEN_TIME_LEN = 8;
const POSITION_UPDATE_TIME_LEN = 8;
const POSITION_SIDE_LEN = 1;
const POSITION_PRICE_LEN = 8;
const POSITION_SIZE_USD_OFFSET =
  POSITION_DISCRIMINATOR_LEN +
  POSITION_OWNER_LEN +
  POSITION_POOL_LEN +
  POSITION_CUSTODY_LEN +
  POSITION_COLLATERAL_LEN +
  POSITION_OPEN_TIME_LEN +
  POSITION_UPDATE_TIME_LEN +
  POSITION_SIDE_LEN +
  POSITION_PRICE_LEN;

async function getOpenPosition(
  connection: Connection,
  owner: PublicKey
): Promise<{ position: PublicKey; side: 'long' | 'short'; sizeUsd: number; collateralUsd: number } | null> {
  const custody = CUSTODY_SOL;
  for (const side of ['long', 'short'] as const) {
    const collateralCustody = side === 'short' ? CUSTODY_USDC : CUSTODY_SOL;
    const position = getPositionPda(owner, custody, collateralCustody, side);
    const info = await connection.getAccountInfo(position);
    if (!info?.data || info.data.length < POSITION_SIZE_USD_OFFSET + 16) continue;
    const sizeUsdRaw = info.data.readBigUInt64LE(POSITION_SIZE_USD_OFFSET);
    const collateralUsdRaw = info.data.readBigUInt64LE(POSITION_SIZE_USD_OFFSET + 8);
    if (sizeUsdRaw === BigInt(0)) continue;
    return {
      position,
      side,
      sizeUsd: Number(sizeUsdRaw) / USD_SCALE,
      collateralUsd: Number(collateralUsdRaw) / USD_SCALE,
    };
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { owner: ownerStr, autoSign = false } = (body || {}) as { owner?: string; autoSign?: boolean };

    const tradingKeyB64 = process.env.TRADING_PRIVATE_KEY;
    let owner: PublicKey;
    let signerKeypair: Keypair | null = null;

    if (autoSign && tradingKeyB64) {
      signerKeypair = Keypair.fromSecretKey(Buffer.from(tradingKeyB64, 'base64'));
      owner = signerKeypair.publicKey;
    } else if (ownerStr) {
      owner = new PublicKey(ownerStr);
    } else {
      return NextResponse.json(
        { success: false, error: 'Need owner or autoSign with TRADING_PRIVATE_KEY' },
        { status: 400 }
      );
    }

    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl);

    const pos = await getOpenPosition(connection, owner);
    if (!pos) {
      return NextResponse.json({ success: false, error: 'No open position found' }, { status: 400 });
    }

    const custody = CUSTODY_SOL;
    const collateralCustody = pos.side === 'short' ? CUSTODY_USDC : CUSTODY_SOL;
    const desiredMint = pos.side === 'short' ? USDC_MINT : NATIVE_MINT;
    const receivingAccount = getAssociatedTokenAddressSync(desiredMint, owner);
    const counter = BigInt(Math.floor(Math.random() * 1_000_000_000));
    const positionRequest = getPositionRequestPda(pos.position, counter);
    const positionRequestAta = getAssociatedTokenAddressSync(desiredMint, positionRequest, true);
    const perpetuals = getPerpetualsPda();

    const provider = new AnchorProvider(connection, { publicKey: owner } as any, AnchorProvider.defaultOptions());
    const program = new Program(perpsIdl as Idl, JUPITER_PERPETUALS_PROGRAM_ID, provider);

    const collateralUsdDelta = new BN(Math.floor(pos.collateralUsd * USD_SCALE));
    const sizeUsdDelta = new BN(Math.floor(pos.sizeUsd * USD_SCALE));
    if (sizeUsdDelta.isZero()) {
      return NextResponse.json({ success: false, error: 'Position size is zero' }, { status: 400 });
    }
    const priceSlippage = new BN(500);

    const decreaseIx = await program.methods
      .createDecreasePositionMarketRequest({
        collateralUsdDelta,
        sizeUsdDelta,
        priceSlippage,
        jupiterMinimumOut: null,
        entirePosition: true,
        counter: new BN(counter.toString()),
      })
      .accounts({
        owner,
        receivingAccount,
        perpetuals,
        pool: JLP_POOL_ACCOUNT_PUBKEY,
        position: pos.position,
        positionRequest,
        positionRequestAta,
        custody,
        collateralCustody,
        desiredMint,
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
      decreaseIx,
    ];

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const txMessage = new TransactionMessage({
      payerKey: owner,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(txMessage);
    if (autoSign && signerKeypair) {
      tx.sign([signerKeypair]);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 4,
      });
      await connection.confirmTransaction(sig, 'confirmed');
      return NextResponse.json({ success: true, data: { signature: sig } });
    }
    return NextResponse.json(
      { success: false, error: 'Close requires autoSign with TRADING_PRIVATE_KEY' },
      { status: 400 }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Close error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
