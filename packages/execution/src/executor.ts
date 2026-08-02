import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ExecutionRequest } from './risk';
import { Wallet } from '@copytrade/database';
import { decrypt } from '@copytrade/common';
import bs58 from 'bs58';

const JUPITER_API_URL = 'https://api.jup.ag/swap/v1';
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

export class ExecutionEngine {
  private connection: Connection;

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  /**
   * Main execution pipeline for a validated ExecutionRequest
   */
  async execute(request: ExecutionRequest, walletData: Wallet, base58PrivateKey: string): Promise<string> {
    console.log(`[Executor] Starting execution for ${request.action} on ${request.tokenMint}`);
    
    // 1. Determine input/output tokens based on action
    const inputMint = request.action === 'BUY' ? NATIVE_SOL_MINT : request.tokenMint;
    const outputMint = request.action === 'BUY' ? request.tokenMint : NATIVE_SOL_MINT;
    
    const keypair = Keypair.fromSecretKey(bs58.decode(base58PrivateKey));
    const userPublicKey = keypair.publicKey.toBase58();

    // 2. Calculate raw amount based on action and token decimals
    let rawAmount = 0;
    if (request.action === 'BUY') {
      rawAmount = Math.floor((request.amountSolIn || 0) * 1e9);
    } else {
      // For SELLs, fetch the user's actual token balance directly from Solana RPC
      rawAmount = await this.getRawTokenAmountForUser(userPublicKey, request.tokenMint, 1.0);
      if (rawAmount <= 0) {
        throw new Error('No on-chain token balance found to sell (token not held in real wallet)');
      }
    }

    if (rawAmount <= 0) throw new Error('Insufficient token balance or invalid amount for execution');

    // 3. Fetch Quote from Jupiter
    const quote = await this.getJupiterQuote(inputMint, outputMint, rawAmount, request.slippageBps);
    if (!quote) throw new Error('Failed to route trade via Jupiter');

    console.log(`[Executor] Jupiter Route found: Expected Output: ${quote.outAmount}`);

    // 4. Build Transaction
    const tx = await this.buildJupiterTransaction(quote, userPublicKey, request.priorityFee);

    // 5. Sign Transaction
    tx.sign([keypair]);
    console.log(`[Executor] Transaction signed by ${userPublicKey}`);

    // 6. Submit Transaction
    if (process.env.SIMULATE_TRADES === 'true') {
      const simResult = await this.connection.simulateTransaction(tx);
      if (simResult.value.err) {
        console.error(`[Executor] Simulation Failed:`, simResult.value.err);
        throw new Error(`Transaction Simulation Failed: ${JSON.stringify(simResult.value.err)}`);
      }
      console.log(`[Executor] Simulation Success! Transaction is valid.`);
      return 'simulated_tx_' + Date.now();
    }

    // Live Broadcast to Solana Mainnet
    const rawTx = tx.serialize();
    const signature = await this.connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 3
    });

    console.log(`[Executor] Transaction broadcasted to Solana Mainnet! Signature: ${signature}`);

    // Wait for confirmation
    const latestBlockHash = await this.connection.getLatestBlockhash();
    await this.connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature
    }, 'confirmed');

    console.log(`[Executor] Transaction confirmed on-chain! Signature: ${signature}`);
    return signature;
  }

  private async getRawTokenAmountForUser(userPublicKey: string, tokenMint: string, percentage: number = 1.0): Promise<number> {
    try {
      const pubKey = new PublicKey(userPublicKey);
      const mintKey = new PublicKey(tokenMint);
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(pubKey, { mint: mintKey });
      if (tokenAccounts.value.length === 0) return 0;

      const info = tokenAccounts.value[0].account.data.parsed.info;
      const rawStringAmount = info.tokenAmount.amount;
      const totalRaw = BigInt(rawStringAmount);
      const targetRaw = BigInt(Math.floor(Number(totalRaw) * percentage));
      return Number(targetRaw);
    } catch (e) {
      console.error('[Executor] Failed to get user token balance from RPC:', e);
      return 0;
    }
  }

  private async getJupiterQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number) {
    let url = `${JUPITER_API_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}`;
    if (slippageBps === 0) {
      url += `&autoSlippage=true&maxAutoSlippageBps=1000`; // Dynamic slippage up to 10%
    } else {
      url += `&slippageBps=${slippageBps}`;
    }
    const response = await fetch(url);
    if (!response.ok) return null;
    return response.json();
  }

  private async buildJupiterTransaction(quoteResponse: any, userPublicKey: string, priorityFee: number): Promise<VersionedTransaction> {
    const response = await fetch(`${JUPITER_API_URL}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priorityFee > 0 ? Math.floor(priorityFee * 1e9) : 'auto'
      })
    });

    if (!response.ok) {
      throw new Error('Failed to build swap transaction via Jupiter');
    }

    const { swapTransaction } = await response.json();
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    return VersionedTransaction.deserialize(swapTransactionBuf);
  }
}

