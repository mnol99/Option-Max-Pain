/**
 * Jupiter Perps execution API
 * Builds createIncreasePositionMarketRequest tx for client to sign & send,
 * or optionally signs and sends server-side (SOLANA_TRADING_SERVER_SIGNING=1).
 */
import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, sendAndConfirmRawTransaction } from '@solana/web3.js';
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
import {
  getServerTradingKeypair,
  isServerTradingSigningEnabled,
} from '@/lib/solana-bot/trading-wallet';

import type { Idl } from '@coral-xyz/anchor';
import minimalIdl from '@/lib/solana-bot/idl/jupiter-perps-minimal.json';

const USD_SCALE = 1_000_000;
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;
const WBTC_DECIMALS = 8;
const WETH_DECIMALS = 8;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      side,
      owner: ownerStr,
      sizeUsd = 100,
      leverage = 1.5,
      solPrice,
      btcPrice,
      ethPrice,
      asset = 'sol',
      signAndSend = false,
    } = body as {
      side: 'long' | 'short';
      owner?: string;
      sizeUsd?: number;
      leverage?: number;
      solPrice?: number;
      btcPrice?: number;
      ethPrice?: number;
      asset?: 'sol' | 'btc' | 'eth';
      signAndSend?: boolean;
    };

    if (!side || !['long', 'short'].includes(side)) {
      return NextResponse.json(
        { success: false, error: 'Invalid body: need side (long|short)' },
        { status: 400 }
      );
    }

    let owner: PublicKey;
    let serverKeypair = null as ReturnType<typeof getServerTradingKeypair>;

    if (signAndSend === true) {
      if (!isServerTradingSigningEnabled()) {
        return NextResponse.json(
          { success: false, error: 'Server signing disabled (set SOLANA_TRADING_SERVER_SIGNING=1)' },
          { status: 403 }
        );
      }
      try {
        serverKeypair = getServerTradingKeypair();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
      }
      if (!serverKeypair) {
        return NextResponse.json(
          {
            success: false,
            error:
              'Server signing enabled but no key: set SOLANA_TRADING_WALLET_KEYPAIR or SOLANA_TRADING_WALLET_SECRET_BASE64',
          },
          { status: 500 }
        );
      }
      owner = serverKeypair.publicKey;
      if (ownerStr && ownerStr !== owner.toBase58()) {
        return NextResponse.json(
          { success: false, error: 'owner pubkey does not match server trading wallet' },
          { status: 403 }
        );
      }
    } else {
      if (!ownerStr) {
        return NextResponse.json(
          { success: false, error: 'Invalid body: need owner (pubkey) when signAndSend is false' },
          { status: 400 }
        );
      }
      owner = new PublicKey(ownerStr);
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

    const useBtc = asset === 'btc';
    const useEth = asset === 'eth';
    const custody = useEth ? CUSTODY_ETH : useBtc ? CUSTODY_BTC : CUSTODY_SOL;
    const collateralCustody =
      side === 'short'
        ? CUSTODY_USDC
        : useBtc
          ? CUSTODY_BTC
          : useEth
            ? CUSTODY_ETH
            : CUSTODY_SOL;
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
      collateralTokenDelta = new BN(
        Math.floor(collateralUsd * Math.pow(10, USDC_DECIMALS))
      );
    } else if (useBtc) {
      if (!btcPrice || btcPrice <= 0) {
        return NextResponse.json(
          { success: false, error: 'btcPrice required for long BTC positions' },
          { status: 400 }
        );
      }
      const collateralBtc = collateralUsd / btcPrice;
      collateralTokenDelta = new BN(
        Math.floor(collateralBtc * Math.pow(10, WBTC_DECIMALS))
      );
    } else if (useEth) {
      if (!ethPrice || ethPrice <= 0) {
        return NextResponse.json(
          { success: false, error: 'ethPrice required for long ETH positions' },
          { status: 400 }
        );
      }
      const collateralWeth = collateralUsd / ethPrice;
      collateralTokenDelta = new BN(
        Math.floor(collateralWeth * Math.pow(10, WETH_DECIMALS))
      );
    } else {
      if (!solPrice || solPrice <= 0) {
        return NextResponse.json(
          { success: false, error: 'solPrice required for long SOL positions' },
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

    if (signAndSend === true && serverKeypair) {
      tx.sign([serverKeypair]);
      const raw = tx.serialize();
      const sig = await sendAndConfirmRawTransaction(connection, Buffer.from(raw), {
        commitment: 'confirmed',
        skipPreflight: false,
      });
      return NextResponse.json({
        success: true,
        data: { signature: sig, owner: owner.toBase58() },
      });
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
