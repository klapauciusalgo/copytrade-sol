import { PrismaClient, CopyStatus, CopyStrategy } from '@copytrade/database';
import { NormalizedEvent } from '@copytrade/blockchain';
import { DecisionEngine } from '../packages/execution/src/decision';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env' });

async function runDecisionSmokeTest() {
  console.log('--- Starting Decision Engine Smoke Test ---');
  const prisma = new PrismaClient();
  const engine = new DecisionEngine();

  try {
    // 1. Setup Mock User & Target in DB
    const user = await prisma.user.create({
      data: {
        telegramId: 'decision_test_' + Date.now(),
        username: 'decision_tester',
        settings: {
          create: {
            defaultSlippage: 1.5, // 1.5% slippage
            priorityFee: 0.005
          }
        },
        wallets: {
          create: {
            publicKey: 'MyMockWalletAddress123',
            encryptedSecret: 'mock_encrypted_secret',
            iv: 'mock_iv',
            copyTargets: {
              create: {
                targetAddress: 'TargetWhaleAddress999',
                status: CopyStatus.ACTIVE,
                strategy: CopyStrategy.FIXED,
                fixedAmount: 0.5 // We want to buy 0.5 SOL exactly
              }
            }
          }
        }
      }
    });

    console.log(`✅ Created Mock User, Wallet, and Copy Target (Fixed 0.5 SOL)`);

    // 2. Mock a Blockchain Event (Target buys a token)
    const mockBuyEvent: NormalizedEvent = {
      wallet: 'TargetWhaleAddress999', // Matches the DB copy target
      action: 'BUY',
      token: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // Bonk token
      amount: 1000000,
      price: 0.000001,
      slot: 123456,
      signature: 'mock_tx_signature'
    };

    console.log(`\nSimulating Blockchain Event: Target bought BONK`);

    // 3. Run Decision Engine
    const requests = await engine.processEvent(mockBuyEvent);

    // 4. Validate output
    if (requests.length === 1) {
      const req = requests[0];
      console.log(`\n✅ Engine Output Success!`);
      console.log(`Execution Request Generated for Wallet ID: ${req.walletId}`);
      console.log(`Action: ${req.action}`);
      console.log(`Token: ${req.tokenMint}`);
      console.log(`Amount SOL In: ${req.amountSolIn} (Expected 0.5)`);
      console.log(`Slippage: ${req.slippageBps} bps (Expected 150)`);
    } else {
      console.error(`❌ Expected 1 execution request, got ${requests.length}`);
    }

    // 5. Test Risk Block (Oversized trade)
    const user2 = await prisma.user.create({
      data: {
        telegramId: 'risk_test_' + Date.now(),
        settings: { create: {} },
        wallets: {
          create: {
            publicKey: 'RiskWallet',
            encryptedSecret: 'secret',
            iv: 'iv',
            copyTargets: {
              create: {
                targetAddress: 'TargetWhaleAddress999',
                status: CopyStatus.ACTIVE,
                strategy: CopyStrategy.FIXED,
                fixedAmount: 10 // 10 SOL (Exceeds 5 SOL risk limit)
              }
            }
          }
        }
      }
    });

    const requestsWithRisk = await engine.processEvent(mockBuyEvent);
    // Should still only be 1 request (for the first user), second user should be blocked
    if (requestsWithRisk.length === 1) {
       console.log(`✅ Risk Engine Success! Blocked oversized 10 SOL trade.`);
    } else {
       console.error(`❌ Risk engine failed to block trade.`);
    }


  } finally {
    await prisma.$disconnect();
    console.log('\n--- Smoke Test Finished ---');
  }
}

runDecisionSmokeTest().catch(console.error);
