import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { Connection } from '@solana/web3.js';
import { PrismaClient } from '@copytrade/database';
import { parseTransaction, WalletMonitor } from '@copytrade/blockchain';
import { DecisionEngine, ExecutionEngine, DryRunEngine } from '@copytrade/execution';
import { decrypt } from '@copytrade/common';
import { Telegraf } from 'telegraf';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '../../../.env') });

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN === 'your_bot_token') {
  console.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');
const prisma = new PrismaClient();
const decisionEngine = new DecisionEngine();
const executionEngine = new ExecutionEngine(RPC_URL);
const dryRunEngine = new DryRunEngine();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const monitor = new WalletMonitor(RPC_URL);

console.log('👷 Worker started, connecting to Redis and waiting for blockchain events...');

// Sync Monitor with Database Targets every 60 seconds
async function syncTargets() {
  const activeTargets = await prisma.copyTarget.findMany({ where: { status: 'ACTIVE' } });
  for (const t of activeTargets) {
    monitor.startWatching(t.targetAddress);
  }
}

setInterval(syncTargets, 60000);
syncTargets(); // initial sync

const worker = new Worker('executionQueue', async (job) => {
  const { wallet, signature, slot } = job.data;
  console.log(`\n[Worker] Processing Job ${job.id} | Signature: ${signature}`);

  try {
    // 1. Fetch Transaction from Solana
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) {
      console.log(`[Worker] Transaction not found or not confirmed yet: ${signature}`);
      return;
    }

    // 2. Parse the Event
    const event = parseTransaction(tx, wallet);
    if (event.action === 'UNKNOWN' || event.action === 'TRANSFER') {
      console.log(`[Worker] Ignored event action: ${event.action}`);
      return;
    }

    console.log(`[Worker] Identified Target Trade! Action: ${event.action}, Token: ${event.token}`);

    // 3. Decision Engine
    const executionRequests = await decisionEngine.processEvent(event);
    if (executionRequests.length === 0) {
      console.log(`[Worker] No execution requests generated (no active users copying, or blocked by risk).`);
      return;
    }

    // 4. Enrich Token Info for Notifications (shared across all modes)
    let tokenSymbol = `${event.token.slice(0, 4)}...${event.token.slice(-4)}`;
    let solPriceUsd = 150;
    try {
      const [solRes, tokenRes] = await Promise.all([
        fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112').catch(() => null),
        fetch(`https://api.dexscreener.com/latest/dex/tokens/${event.token}`).catch(() => null)
      ]);
      if (solRes) {
        const data = await solRes.json();
        const solPair = data.pairs?.find((p: any) => p.chainId === 'solana' && (p.quoteToken.symbol === 'USDC' || p.quoteToken.symbol === 'USDT'));
        if (solPair?.priceUsd) solPriceUsd = parseFloat(solPair.priceUsd);
      }
      if (tokenRes) {
        const data = await tokenRes.json();
        const tokenPair = data.pairs?.find((p: any) => p.chainId === 'solana') || data.pairs?.[0];
        if (tokenPair?.baseToken?.symbol) tokenSymbol = tokenPair.baseToken.symbol;
      }
    } catch (e) {
      console.error('[Worker] Failed to enrich event data', e);
    }

    const tradeSolSize = event.amount * event.price;
    const tradeUsdSize = (tradeSolSize * solPriceUsd).toFixed(2);

    // 5. Execution loop (For each user/target)
    for (const req of executionRequests) {
      const userWallet = await prisma.wallet.findUnique({
        where: { id: req.walletId },
        include: { user: { include: { settings: true } } }
      });
      if (!userWallet) continue;

      const telegramId = userWallet.user.telegramId;

      // ── MONITOR MODE ────────────────────────────────────────────────────────
      if (req.mode === 'MONITOR') {
        const msg = `👁️ <b>Monitor Alert!</b>\n\n🎯 <b>Target:</b> <code>${event.wallet}</code>\n🔔 <b>Action:</b> ${req.action}\n🪙 <b>Token:</b> ${tokenSymbol} (<code>${req.tokenMint}</code>)\n💵 <b>Value:</b> $${tradeUsdSize} (${tradeSolSize.toFixed(4)} SOL)\n💡 <i>Monitor mode is ON. No trade executed.</i>`;
        await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
        continue;
      }

      // ── DRY RUN MODE ────────────────────────────────────────────────────────
      if (req.mode === 'DRY_RUN') {
        if (!userWallet.user.settings) {
          console.log(`[Worker] DRY_RUN: no settings for user ${telegramId}, skipping`);
          continue;
        }

        const solToSpend = req.amountSolIn ?? userWallet.user.settings.dryRunEquitySol * 0.1;

        let result;
        if (req.action === 'BUY') {
          result = await dryRunEngine.processBuy(
            req.walletId, userWallet.userId, event.wallet,
            req.tokenMint, tokenSymbol,
            solToSpend, event.amount, event.price
          );
        } else {
          result = await dryRunEngine.processSell(
            req.walletId, userWallet.userId, event.wallet,
            req.tokenMint, tokenSymbol, event.price
          );
        }

        if (result.skipped) {
          const msg = `🧪 <b>Dry Run — Skipped</b>\n\n🎯 <b>Target:</b> <code>${event.wallet}</code>\n🔔 <b>Action:</b> ${req.action}\n🪙 <b>Token:</b> ${tokenSymbol}\n⚠️ <i>${result.skipReason}</i>`;
          await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
        } else if (result.action === 'BUY') {
          const buyUsd = ((result.virtualSolSpent ?? 0) * solPriceUsd).toFixed(2);
          const msg = `🧪 <b>Dry Run — BUY Simulated</b>\n\n🎯 <b>Target:</b> <code>${event.wallet}</code>\n🪙 <b>Token:</b> ${tokenSymbol} (<code>${req.tokenMint}</code>)\n💵 <b>Spent:</b> $${buyUsd} (${result.virtualSolSpent?.toFixed(4)} SOL)\n💰 <b>Virtual Equity Left:</b> ${result.remainingEquitySol?.toFixed(4)} SOL\n\n<i>No real trade executed.</i>`;
          await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
        } else if (result.action === 'SELL') {
          const pnlEmoji = (result.pnlSol ?? 0) >= 0 ? '🟢' : '🔴';
          const pnlSign = (result.pnlSol ?? 0) >= 0 ? '+' : '';
          const receivedUsd = ((result.virtualSolReceived ?? 0) * solPriceUsd).toFixed(2);
          const pnlUsd = ((result.pnlSol ?? 0) * solPriceUsd).toFixed(2);
          const msg = `🧪 <b>Dry Run — SELL Simulated</b>\n\n🎯 <b>Target:</b> <code>${event.wallet}</code>\n🪙 <b>Token:</b> ${tokenSymbol} (<code>${req.tokenMint}</code>)\n💵 <b>Received:</b> $${receivedUsd} (${result.virtualSolReceived?.toFixed(4)} SOL)\n\n${pnlEmoji} <b>P&amp;L: ${pnlSign}${result.pnlSol?.toFixed(4)} SOL ($${pnlSign}${pnlUsd}) (${pnlSign}${result.pnlPercent?.toFixed(1)}%)</b>\n\n💰 <b>Virtual Equity:</b> ${result.remainingEquitySol?.toFixed(4)} SOL\n\n<i>No real trade executed.</i>`;
          await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
        }
        continue;
      }

      // ── COPY MODE (real execution) ───────────────────────────────────────────
      const privateKeyBase58 = decrypt(userWallet.encryptedSecret, userWallet.iv);
      try {
        const simResultOrSignature = await executionEngine.execute(req, userWallet as any, privateKeyBase58);
        console.log(`[Worker] Executed successfully for Telegram ID ${telegramId}`);

        const message = `✅ <b>Trade Executed!</b>\n\n🎯 <b>Target:</b> <code>${event.wallet}</code>\n🔔 <b>Action:</b> ${req.action}\n🪙 <b>Token:</b> ${tokenSymbol} (<code>${req.tokenMint}</code>)\n💵 <b>Value:</b> $${tradeUsdSize} (${tradeSolSize.toFixed(4)} SOL)\n\n🔗 <a href="https://solscan.io/tx/${simResultOrSignature}">View Transaction</a>`;
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML' }).catch(() => {});

      } catch (err: any) {
        console.error(`[Worker] Failed to execute for ${telegramId}: ${err.message}`);
        await bot.telegram.sendMessage(telegramId, `❌ <b>Trade Failed</b>\nTarget: <code>${event.wallet}</code>\nReason: ${err.message}`, { parse_mode: 'HTML' }).catch(() => {});
      }
    }

  } catch (err) {
    console.error(`[Worker] Critical error processing job:`, err);
    throw err;
  }
}, {
  connection: new Redis(REDIS_URL)
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed with error:`, err);
});
