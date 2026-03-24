/**
 * Jupiter Perps execution API
 * Builds createIncreasePositionMarketRequest tx for client to sign & send.
 * When autoSign=true and TRADING_PRIVATE_KEY (base64) is set, signs and sends server-side.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
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
  CUSTODY_USDC,
  USDC_MINT,
  getPositionPda,
  getPositionRequestPda,
  getPerpetualsPda,
} from '@/lib/solana-bot/jupiter-perps';

import type { Idl } from '@coral-xyz/anchor';
import minimalIdl from '@/lib/solana-bot/idl/jupiter-perps-minimal.json';

const USD_SCALE = 1_000_000;
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      side,
      owner: ownerStr,
      sizeUsd = 100,
      leverage = 1.5,
      solPrice,
      autoSign = false,
    } = body as {
      side: 'long' | 'short';
      owner: string;
      sizeUsd?: number;
      leverage?: number;
      solPrice?: number;
      autoSign?: boolean;
    };

    if (!ownerStr || !side || !['long', 'short'].includes(side)) {
      return NextResponse.json(
        { success: false, error: 'Invalid body: need side (long|short) and owner (pubkey)' },
        { status: 400 }
      );
    }

    const owner = new PublicKey(ownerStr);
    const tradingKeyB64 = process.env.TRADING_PRIVATE_KEY;
    if (autoSign && (!tradingKeyB64 || tradingKeyB64.length < 32)) {
      return NextResponse.json(
        { success: false, error: 'autoSign requires TRADING_PRIVATE_KEY (base64) in env' },
        { status: 400 }
      );
    }
    let signerKeypair: Keypair | null = null;
    if (autoSign && tradingKeyB64) {
      signerKeypair = Keypair.fromSecretKey(Buffer.from(tradingKeyB64, 'base64'));
      if (signerKeypair.publicKey.toString() !== ownerStr) {
        return NextResponse.json(
          { success: false, error: 'owner must match TRADING_PRIVATE_KEY when autoSign' },
          { status: 400 }
        );
      }
    }
    const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
    const connection = new Connection(rpcUrl);

    const provider = new AnchorProvider(
      connection,
      { publicKey: owner } as any,
      AnchorProvider.defaultOptions()
    );
    const program = new Program(
      minimalIdl as Idl,
      JUPITER_PERPETUALS_PROGRAM_ID,
      provider
    );

    const custody = CUSTODY_SOL;
    const collateralCustody = side === 'short' ? CUSTODY_USDC : CUSTODY_SOL;
    const inputMint = side === 'short' ? USDC_MINT : NATIVE_MINT;

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
      collateralTokenDelta = new BN(
        Math.floor(collateralUsd * Math.pow(10, USDC_DECIMALS))
      );
    } else {
      if (!solPrice || solPrice <= 0) {
        return NextResponse.json(
          { success: false, error: 'solPrice required for long positions' },
          { status: 400 }
        );
      }
      const collateralSol = collateralUsd / solPrice;
      collateralTokenDelta = new BN(
        Math.floor(collateralSol * Math.pow(10, SOL_DECIMALS))
      );
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
      postInstructions.push(
        createCloseAccountInstruction(fundingAccount, owner, owner)
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
    if (autoSign && signerKeypair) {
      tx.sign([signerKeypair]);
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 4,
      });
      await connection.confirmTransaction(sig, 'confirmed');
      return NextResponse.json({ success: true, data: { signature: sig } });
    }
    const serialized = Buffer.from(tx.serialize()).toString('base64');
    return NextResponse.json({ success: true, data: { serializedTx: serialized } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Execute error:', msg);
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
