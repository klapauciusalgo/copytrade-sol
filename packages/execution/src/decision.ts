import { NormalizedEvent } from '@copytrade/blockchain';
import { PrismaClient, CopyTarget, Wallet, UserSettings } from '@copytrade/database';
import { calculatePositionSize } from './sizing';
import { validateRisk, ExecutionRequest } from './risk';

const prisma = new PrismaClient();

export class DecisionEngine {
  async processEvent(event: NormalizedEvent): Promise<ExecutionRequest[]> {
    if (event.action !== 'BUY' && event.action !== 'SELL') {
      return []; // Ignore transfers or unknown actions
    }

    // 1. Find all users copying this target wallet
    const activeTargets = await prisma.copyTarget.findMany({
      where: {
        targetAddress: event.wallet,
        status: 'ACTIVE'
      },
      include: {
        wallet: {
          include: {
            user: {
              include: { settings: true }
            }
          }
        }
      }
    });

    const executionRequests: ExecutionRequest[] = [];

    for (const target of activeTargets) {
      const userSettings = target.wallet.user.settings;
      if (!userSettings) continue;

      // 2. Calculate Size
      const positionSol = calculatePositionSize(event, target);
      if (positionSol <= 0) continue;

      // 3. Risk Validation
      const isSafe = validateRisk(target, target.wallet, userSettings, event.token, positionSol);
      if (!isSafe) continue;

      // 4. Build Execution Request
      executionRequests.push({
        walletId: target.wallet.id,
        tokenMint: event.token,
        action: event.action,
        amountSolIn: event.action === 'BUY' ? positionSol : undefined,
        // For sells, ideally we determine token balance to sell 100%. 
        // For now, if RATIO, we just mock selling a proportion.
        amountTokenIn: event.action === 'SELL' ? event.amount * (target.ratio || 1) : undefined,
        slippageBps: userSettings.defaultSlippage * 100, // e.g. 1% = 100 bps
        priorityFee: userSettings.priorityFee,
        mode: target.mode as 'COPY' | 'MONITOR'
      });
    }

    return executionRequests;
  }
}
