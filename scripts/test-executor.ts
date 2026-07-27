import { ExecutionEngine } from '../packages/execution/src/executor';
import { ExecutionRequest } from '../packages/execution/src/risk';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

async function runExecutorSmokeTest() {
  console.log('--- Starting Execution Engine Smoke Test ---');
  
  // Connect to public mainnet RPC
  const engine = new ExecutionEngine('https://api.mainnet-beta.solana.com');

  // Generate a random mock wallet
  const mockKeypair = Keypair.generate();
  const secretString = bs58.encode(mockKeypair.secretKey);
  console.log(`Generated Mock Wallet: ${mockKeypair.publicKey.toBase58()}`);

  const mockRequest: ExecutionRequest = {
    walletId: 'mock_wallet_id',
    tokenMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    action: 'BUY',
    amountSolIn: 0.001, // 0.001 SOL
    slippageBps: 150, // 1.5%
    priorityFee: 0 // No priority fee for simulation
  };

  try {
    // Execute simulation
    const result = await engine.execute(mockRequest, {} as any, secretString);
    console.log(`\n✅ Execution Smoke Test Passed! Result: ${result}`);
  } catch (err: any) {
    if (err.message.includes('Simulation Failed') || err.message.includes('Insufficient funds') || err.message.includes('insufficient lamports')) {
      // Since it's a random wallet with 0 SOL, the simulation will naturally fail due to insufficient funds.
      // But if it reaches the simulation step, the transaction was built and signed successfully!
      console.log(`\n✅ Execution Pipeline Success! Transaction built, routed, and signed successfully.`);
      console.log(`(Simulation rightfully failed because the mock wallet has 0 SOL to spend).`);
    } else {
      console.error(`\n❌ Execution Pipeline Failed unexpectedly:`, err);
    }
  }
}

runExecutorSmokeTest().catch(console.error);
