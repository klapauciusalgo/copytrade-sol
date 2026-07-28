import { PrismaClient } from '@copytrade/database';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '.env') });
const prisma = new PrismaClient();

async function generateReportData() {
  const users = await prisma.user.findMany({
    include: {
      settings: true,
      wallets: {
        include: {
          copyTargets: true,
          dryRunPositions: true
        }
      }
    }
  });

  // Get current SOL price
  let solPriceUsd = 180;
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const data = await res.json();
    const solPair = data.pairs?.find((p: any) => p.chainId === 'solana' && (p.quoteToken.symbol === 'USDC' || p.quoteToken.symbol === 'USDT'));
    if (solPair?.priceUsd) solPriceUsd = parseFloat(solPair.priceUsd);
  } catch (e) {}

  for (const u of users) {
    if (!u.wallets || u.wallets.length === 0) continue;
    const wallet = u.wallets[0];
    const positions = wallet.dryRunPositions;
    const availableEquity = u.settings?.dryRunEquitySol || 1.0;

    let totalSpentSol = 0;
    let totalCurrentValueSol = 0;

    const reportRows = [];

    for (const pos of positions) {
      totalSpentSol += pos.virtualSolSpent;
      let currentPriceSol = pos.buyPriceSol;
      let priceUsd = 0;

      try {
        const tokenRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pos.tokenMint}`);
        const tokenData = await tokenRes.json();
        const pair = tokenData.pairs?.find((p: any) => p.chainId === 'solana') || tokenData.pairs?.[0];
        if (pair?.priceNative) {
          currentPriceSol = parseFloat(pair.priceNative);
          priceUsd = parseFloat(pair.priceUsd || '0');
        }
      } catch (e) {}

      const currentValueSol = pos.tokenAmount * currentPriceSol;
      totalCurrentValueSol += currentValueSol;

      const pnlSol = currentValueSol - pos.virtualSolSpent;
      const pnlPercent = (pnlSol / pos.virtualSolSpent) * 100;

      reportRows.push({
        symbol: pos.tokenSymbol || pos.tokenMint.slice(0, 6),
        mint: pos.tokenMint,
        spentSol: pos.virtualSolSpent,
        tokenAmount: pos.tokenAmount,
        buyPriceSol: pos.buyPriceSol,
        currentPriceSol,
        currentValueSol,
        pnlSol,
        pnlPercent
      });
    }

    console.log(JSON.stringify({
      telegramId: u.telegramId,
      username: u.username,
      solPriceUsd,
      availableEquity,
      totalSpentSol,
      totalCurrentValueSol,
      portfolioTotalSol: availableEquity + totalCurrentValueSol,
      totalUnrealizedPnlSol: totalCurrentValueSol - totalSpentSol,
      rows: reportRows
    }, null, 2));
  }

  await prisma.$disconnect();
}

generateReportData();
