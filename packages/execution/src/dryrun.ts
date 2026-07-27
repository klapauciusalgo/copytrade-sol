import { PrismaClient } from '@copytrade/database';

const prisma = new PrismaClient();

export interface DryRunResult {
  action: 'BUY' | 'SELL';
  tokenMint: string;
  tokenSymbol: string;
  virtualSolSpent?: number;    // BUY: SOL "used"
  virtualSolReceived?: number; // SELL: SOL "received" (estimated)
  pnlSol?: number;             // SELL: Realized P&L in SOL
  pnlPercent?: number;         // SELL: P&L %
  remainingEquitySol?: number; // Equity remaining after trade
  skipped: boolean;
  skipReason?: string;
}

export class DryRunEngine {
  async processBuy(
    walletId: string,
    userId: string,
    targetAddress: string,
    tokenMint: string,
    tokenSymbol: string,
    solToSpend: number,
    tokenAmount: number,
    buyPriceSol: number
  ): Promise<DryRunResult> {
    const userSettings = await prisma.userSettings.findUnique({ where: { userId } });
    if (!userSettings) {
      return { action: 'BUY', tokenMint, tokenSymbol, skipped: true, skipReason: 'User settings not found' };
    }

    const currentEquity = userSettings.dryRunEquitySol;

    // Not enough virtual equity
    if (solToSpend > currentEquity) {
      return {
        action: 'BUY', tokenMint, tokenSymbol, skipped: true,
        skipReason: `Insufficient virtual equity (have ${currentEquity.toFixed(4)} SOL, need ${solToSpend.toFixed(4)} SOL)`
      };
    }

    // Prevent division by zero
    const safeTokenAmount = tokenAmount > 0 ? tokenAmount : 1;
    const safeBuyPriceSol = buyPriceSol > 0 ? buyPriceSol : solToSpend / safeTokenAmount;

    // Upsert: support averaging down if position already exists
    const existing = await prisma.dryRunPosition.findUnique({
      where: { walletId_targetAddress_tokenMint: { walletId, targetAddress, tokenMint } }
    });

    if (existing) {
      const totalSol = existing.virtualSolSpent + solToSpend;
      const totalTokens = existing.tokenAmount + safeTokenAmount;
      const newAvgPrice = totalSol / totalTokens;
      await prisma.dryRunPosition.update({
        where: { id: existing.id },
        data: { virtualSolSpent: totalSol, tokenAmount: totalTokens, buyPriceSol: newAvgPrice, tokenSymbol }
      });
    } else {
      await prisma.dryRunPosition.create({
        data: { walletId, targetAddress, tokenMint, tokenSymbol, virtualSolSpent: solToSpend, tokenAmount: safeTokenAmount, buyPriceSol: safeBuyPriceSol }
      });
    }

    // Deduct from virtual equity
    await prisma.userSettings.update({
      where: { userId },
      data: { dryRunEquitySol: { decrement: solToSpend } }
    });

    return {
      action: 'BUY', tokenMint, tokenSymbol, skipped: false,
      virtualSolSpent: solToSpend,
      remainingEquitySol: currentEquity - solToSpend
    };
  }

  async processSell(
    walletId: string,
    userId: string,
    targetAddress: string,
    tokenMint: string,
    tokenSymbol: string,
    currentPriceSol: number
  ): Promise<DryRunResult> {
    const position = await prisma.dryRunPosition.findUnique({
      where: { walletId_targetAddress_tokenMint: { walletId, targetAddress, tokenMint } }
    });

    if (!position) {
      return {
        action: 'SELL', tokenMint, tokenSymbol, skipped: true,
        skipReason: 'No open virtual position for this token (target may have bought before dry-run was activated)'
      };
    }

    const safeCurrentPrice = currentPriceSol > 0 ? currentPriceSol : position.buyPriceSol;
    const solReceived = position.tokenAmount * safeCurrentPrice;
    const pnlSol = solReceived - position.virtualSolSpent;
    const pnlPercent = position.virtualSolSpent > 0 ? (pnlSol / position.virtualSolSpent) * 100 : 0;

    // Close the position
    await prisma.dryRunPosition.delete({ where: { id: position.id } });

    // Return SOL to virtual equity
    const updatedSettings = await prisma.userSettings.update({
      where: { userId },
      data: { dryRunEquitySol: { increment: solReceived } }
    });

    return {
      action: 'SELL', tokenMint, tokenSymbol, skipped: false,
      virtualSolSpent: position.virtualSolSpent,
      virtualSolReceived: solReceived,
      pnlSol, pnlPercent,
      remainingEquitySol: updatedSettings.dryRunEquitySol
    };
  }

  async resetPortfolio(walletId: string, userId: string, newEquitySol: number): Promise<void> {
    // Close all open positions for this wallet
    await prisma.dryRunPosition.deleteMany({ where: { walletId } });
    // Reset equity to the configured value
    await prisma.userSettings.update({
      where: { userId },
      data: { dryRunEquitySol: newEquitySol }
    });
  }

  async getOpenPositions(walletId: string): Promise<any[]> {
    return prisma.dryRunPosition.findMany({ where: { walletId } });
  }
}
