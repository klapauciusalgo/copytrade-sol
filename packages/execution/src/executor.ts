import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { ExecutionRequest } from './risk';
import { Wallet } from '@copytrade/database';
import { decrypt } from '@copytrade/common';
import bs58 from 'bs58';

const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';
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
    
    // Calculate raw amount. SOL has 9 decimals.
    // For MVP SELLs, we mock 1 token unit. In production, we'd fetch the exact token balance.
    const rawAmount = request.action === 'BUY' 
      ? Math.floor((request.amountSolIn || 0) * 1e9) 
      : Math.floor((request.amountTokenIn || 0) * 1e6); // Assuming 6 decimals for random tokens as fallback

    if (rawAmount <= 0) throw new Error('Invalid amount for execution');

    // 2. Fetch Quote from Jupiter
    const quote = await this.getJupiterQuote(inputMint, outputMint, rawAmount, request.slippageBps);
    if (!quote) throw new Error('Failed to route trade via Jupiter');

    console.log(`[Executor] Jupiter Route found: Expected Output: ${quote.outAmount}`);

    // 3. Build Transaction
    const keypair = Keypair.fromSecretKey(bs58.decode(base58PrivateKey));
    const tx = await this.buildJupiterTransaction(quote, keypair.publicKey.toBase58(), request.priorityFee);

    // 4. Sign Transaction
    tx.sign([keypair]);
    console.log(`[Executor] Transaction signed by ${keypair.publicKey.toBase58()}`);

    // 5. Submit Transaction
    // For smoke testing, we won't actually broadcast unless we want a real tx. 
    // We will just simulate it to ensure the payload is completely valid.
    const simResult = await this.connection.simulateTransaction(tx);
    
    if (simResult.value.err) {
      console.error(`[Executor] Simulation Failed:`, simResult.value.err);
      throw new Error('Transaction Simulation Failed');
    }

    console.log(`[Executor] Simulation Success! Transaction is valid and ready to broadcast.`);
    
    // In production:
    // const signature = await this.connection.sendTransaction(tx, { maxRetries: 3 });
    // return signature;
    
    return 'mocked_success_signature_' + Date.now();
  }

  private async getJupiterQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number) {
    const url = `${JUPITER_API_URL}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
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
        throw new Error('Failed to build swap transaction');
    }

    const { swapTransaction } = await response.json();
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    return VersionedTransaction.deserialize(swapTransactionBuf);
  }
}
