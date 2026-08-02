import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { Connection, PublicKey } from '@solana/web3.js';
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
    let tokenPriceSol = 0;
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
        if (tokenPair?.priceNative) {
          tokenPriceSol = parseFloat(tokenPair.priceNative);
        } else if (tokenPair?.priceUsd) {
          tokenPriceSol = parseFloat(tokenPair.priceUsd) / solPriceUsd;
        }
      }
      } catch (e) {
        console.error('[Worker] Failed to enrich event data', e);
      }

      const effectivePrice = event.price > 0 ? event.price : tokenPriceSol;
      const tradeSolSize = event.amount * (effectivePrice || 1);
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
        const myTokenAmount = event.price > 0 ? solToSpend / event.price : event.amount;

        let result;
        if (req.action === 'BUY') {
          result = await dryRunEngine.processBuy(
            req.walletId, userWallet.userId, event.wallet,
            req.tokenMint, tokenSymbol,
            solToSpend, myTokenAmount, event.price
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

        if (req.action === 'BUY') {
          await prisma.livePosition.upsert({
            where: {
              walletId_targetAddress_tokenMint: {
                walletId: req.walletId,
                targetAddress: event.wallet,
                tokenMint: req.tokenMint
              }
            },
            create: {
              walletId: req.walletId,
              targetAddress: event.wallet,
              tokenMint: req.tokenMint,
              tokenSymbol,
              solSpent: tradeSolSize,
              tokenAmount: 0,
              buyPriceSol: effectivePrice > 0 ? effectivePrice : 0
            },
            update: {
              solSpent: { increment: tradeSolSize },
              buyPriceSol: effectivePrice > 0 ? effectivePrice : undefined
            }
          }).catch((e) => console.error('[Worker] Error upserting LivePosition:', e));
        } else if (req.action === 'SELL') {
          await prisma.livePosition.deleteMany({
            where: {
              walletId: req.walletId,
              tokenMint: req.tokenMint
            }
          }).catch((e) => console.error('[Worker] Error deleting LivePosition:', e));
        }

        const message = `✅ <b>Trade Executed!</b>\n\n🎯 <b>Target:</b> <code>${event.wallet}</code>\n🔔 <b>Action:</b> ${req.action}\n🪙 <b>Token:</b> ${tokenSymbol} (<code>${req.tokenMint}</code>)\n💵 <b>Value:</b> $${tradeUsdSize} (${tradeSolSize.toFixed(4)} SOL)\n\n🔗 <a href="https://solscan.io/tx/${simResultOrSignature}">View Transaction</a>`;
        await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML' }).catch(() => {});

      } catch (err: any) {
        const errMsg = err?.message || String(err);
        console.error(`[Worker] Failed to execute for ${telegramId}: ${errMsg}`);
        
        let title = '❌ <b>Trade Failed</b>';
        let formattedReason = errMsg;

        if (errMsg.includes('No on-chain token balance')) {
          title = '⚠️ <b>Trade Skipped (No Token Balance)</b>';
          formattedReason = 'Anda tidak memiliki saldo token ini di dompet riil (mungkin dibeli target sebelum mode live aktif).';
        } else if (errMsg.includes('insufficient lamports') || errMsg.includes('0x1') || errMsg.includes('Insufficient token balance') || errMsg.includes('Insufficient SOL')) {
          title = '⚠️ <b>Trade Skipped (Saldo SOL Tidak Cukup)</b>';
          formattedReason = 'Saldo SOL di dompet Anda tidak cukup untuk mengeksekusi pembelian (order size + gas fee). Silakan top up SOL ke dompet Anda.';
        } else if (errMsg.includes('0x1771') || errMsg.includes('6001') || errMsg.includes('SlippageToleranceExceeded')) {
          title = '⚠️ <b>Trade Failed (Slippage Exceeded)</b>';
          formattedReason = 'Harga koin melonjak terlalu cepat melebihi Slippage (Slippage Exceeded). Disarankan menaikkan Slippage di /settings jika sering terjadi.';
        } else if (errMsg.includes('Simulation')) {
          title = '⚠️ <b>Trade Failed (Simulation Error)</b>';
          formattedReason = `Simulasi transaksi gagal: ${errMsg.slice(0, 150)}...`;
        }

        const msg = `${title}\n\n🎯 <b>Target:</b> <code>${event.wallet}</code>\n🔔 <b>Action:</b> ${req.action}\n🪙 <b>Token:</b> ${tokenSymbol} (<code>${req.tokenMint}</code>)\n💡 <i>${formattedReason}</i>`;
        await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
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

// ── STOP LOSS MONITORING ENGINE ────────────────────────────────────────────────
async function checkStopLoss() {
  try {
    const usersWithStopLoss = await prisma.userSettings.findMany({
      where: { stopLossPercent: { gt: 0 } },
      include: {
        user: {
          include: {
            wallets: {
              include: {
                livePositions: true,
                dryRunPositions: true
              }
            }
          }
        }
      }
    });

    if (usersWithStopLoss.length === 0) return;

    // Fetch current SOL price once
    let solPriceUsd = 150;
    const solRes = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112').catch(() => null);
    if (solRes && solRes.ok) {
      const sData = await solRes.json();
      const p = sData.pairs?.[0]?.priceUsd;
      if (p) solPriceUsd = parseFloat(p);
    }

    for (const settings of usersWithStopLoss) {
      const stopLossPercent = settings.stopLossPercent;
      const user = settings.user;

      for (const wallet of user.wallets) {
        // 0. Auto-sync on-chain holdings into LivePosition if not tracked
        try {
          const pubKey = new PublicKey(wallet.publicKey);
          const [parsedSpl, parsed2022] = await Promise.all([
            connection.getParsedTokenAccountsByOwner(pubKey, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }).catch(() => ({ value: [] })),
            connection.getParsedTokenAccountsByOwner(pubKey, { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }).catch(() => ({ value: [] }))
          ]);
          const allAccounts = [...parsedSpl.value, ...parsed2022.value];

          for (const acc of allAccounts) {
            const info = acc.account.data.parsed.info;
            const amount = parseFloat(info.tokenAmount.uiAmountString || '0');
            const mint = info.mint;
            if (amount > 0) {
              const exists = wallet.livePositions.some(p => p.tokenMint === mint);
              if (!exists) {
                const tRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
                let initPriceSol = 0;
                let sym = mint.slice(0, 4);
                if (tRes && tRes.ok) {
                  const tData = await tRes.json();
                  const pair = tData.pairs?.[0];
                  if (pair?.priceNative) initPriceSol = parseFloat(pair.priceNative);
                  if (pair?.baseToken?.symbol) sym = pair.baseToken.symbol;
                }

                const newPos = await prisma.livePosition.create({
                  data: {
                    walletId: wallet.id,
                    targetAddress: 'onchain_holdings',
                    tokenMint: mint,
                    tokenSymbol: sym,
                    solSpent: 0,
                    tokenAmount: amount,
                    buyPriceSol: initPriceSol
                  }
                }).catch(() => null);
                if (newPos) {
                  wallet.livePositions.push(newPos);
                  console.log(`[StopLoss] Auto-synced held token ${sym} (${mint}) into LivePosition at ${initPriceSol.toFixed(6)} SOL`);
                }
              }
            }
          }
        } catch (e) {
          console.error('[StopLoss] Error syncing on-chain live positions:', e);
        }

        // 1. Check Live Positions (COPY mode)
        for (const pos of wallet.livePositions) {
          const tokenRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pos.tokenMint}`).catch(() => null);
          let currentPriceSol = 0;
          if (tokenRes && tokenRes.ok) {
            const tData = await tokenRes.json();
            const pair = tData.pairs?.[0];
            if (pair?.priceNative) {
              currentPriceSol = parseFloat(pair.priceNative);
            } else if (pair?.priceUsd) {
              currentPriceSol = parseFloat(pair.priceUsd) / solPriceUsd;
            }
          }

          if (currentPriceSol <= 0) continue;

          let entryPrice = pos.buyPriceSol;
          if (!entryPrice || entryPrice <= 0) {
            entryPrice = currentPriceSol;
            await prisma.livePosition.update({
              where: { id: pos.id },
              data: { buyPriceSol: currentPriceSol }
            }).catch(() => {});
            console.log(`[StopLoss] Initialized entry price for ${pos.tokenMint} at ${currentPriceSol.toFixed(6)} SOL`);
          }

          const dropPercent = ((entryPrice - currentPriceSol) / entryPrice) * 100;
          console.log(`[StopLoss][Live] ${pos.tokenSymbol || pos.tokenMint.slice(0, 6)}: Entry=${entryPrice.toFixed(6)} SOL, Current=${currentPriceSol.toFixed(6)} SOL, Drop=${dropPercent.toFixed(2)}% (Limit: -${stopLossPercent}%)`);

          if (dropPercent >= stopLossPercent) {
            console.log(`[StopLoss] 🚨 TRIGGERED for LivePosition ${pos.tokenMint}! Drop: ${dropPercent.toFixed(2)}% >= ${stopLossPercent}%`);
            
            const privateKeyBase58 = decrypt(wallet.encryptedSecret, wallet.iv);
            const req = {
              walletId: wallet.id,
              tokenMint: pos.tokenMint,
              action: 'SELL' as const,
              slippageBps: 300,
              priorityFee: settings.priorityFee,
              mode: 'COPY' as const
            };

            try {
              const txSig = await executionEngine.execute(req, wallet as any, privateKeyBase58);
              await prisma.livePosition.delete({ where: { id: pos.id } }).catch(() => {});

              const msg = `🛑 <b>AUTO SELL TRIGGERED (Stop Loss)</b>\n\n🎯 <b>Target:</b> <code>${pos.targetAddress}</code>\n🪙 <b>Token:</b> ${pos.tokenSymbol || 'Token'} (<code>${pos.tokenMint}</code>)\n📉 <b>Loss:</b> -${dropPercent.toFixed(1)}% (Threshold: -${stopLossPercent}%)\n💵 <b>Entry:</b> ${entryPrice.toFixed(6)} SOL | <b>Current:</b> ${currentPriceSol.toFixed(6)} SOL\n\n🔗 <a href="https://solscan.io/tx/${txSig}">View Transaction</a>\n\n✅ <i>Position automatically closed to protect your capital.</i>`;
              await bot.telegram.sendMessage(user.telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
            } catch (err: any) {
              console.error(`[StopLoss] Failed to execute live stop loss sell:`, err);
            }
          }
        }

        // 2. Check Dry Run Positions (DRY_RUN mode)
        for (const pos of wallet.dryRunPositions) {
          const tokenRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pos.tokenMint}`).catch(() => null);
          let currentPriceSol = 0;
          if (tokenRes && tokenRes.ok) {
            const tData = await tokenRes.json();
            const pair = tData.pairs?.[0];
            if (pair?.priceNative) {
              currentPriceSol = parseFloat(pair.priceNative);
            } else if (pair?.priceUsd) {
              currentPriceSol = parseFloat(pair.priceUsd) / solPriceUsd;
            }
          }

          if (currentPriceSol <= 0) continue;

          let entryPrice = pos.buyPriceSol;
          if (!entryPrice || entryPrice <= 0) {
            entryPrice = currentPriceSol;
            await prisma.dryRunPosition.update({
              where: { id: pos.id },
              data: { buyPriceSol: currentPriceSol }
            }).catch(() => {});
          }

          const dropPercent = ((entryPrice - currentPriceSol) / entryPrice) * 100;
          console.log(`[StopLoss][DryRun] ${pos.tokenSymbol || pos.tokenMint.slice(0, 6)}: Entry=${entryPrice.toFixed(6)} SOL, Current=${currentPriceSol.toFixed(6)} SOL, Drop=${dropPercent.toFixed(2)}% (Limit: -${stopLossPercent}%)`);

          if (dropPercent >= stopLossPercent) {
            console.log(`[StopLoss] 🚨 TRIGGERED for DryRunPosition ${pos.tokenMint}! Drop: ${dropPercent.toFixed(2)}% >= ${stopLossPercent}%`);

            const result = await dryRunEngine.processSell(
              wallet.id, user.id, pos.targetAddress,
              pos.tokenMint, pos.tokenSymbol, currentPriceSol
            );

            if (!result.skipped) {
              const msg = `🛑 <b>DRY RUN AUTO SELL (Stop Loss)</b>\n\n🎯 <b>Target:</b> <code>${pos.targetAddress}</code>\n🪙 <b>Token:</b> ${pos.tokenSymbol || 'Token'} (<code>${pos.tokenMint}</code>)\n📉 <b>Loss:</b> -${dropPercent.toFixed(1)}% (Threshold: -${stopLossPercent}%)\n🔴 <b>Realized P&amp;L:</b> ${result.pnlSol?.toFixed(4)} SOL (${result.pnlPercent?.toFixed(1)}%)\n💰 <b>Virtual Equity:</b> ${result.remainingEquitySol?.toFixed(4)} SOL\n\n<i>Virtual position closed to protect virtual capital.</i>`;
              await bot.telegram.sendMessage(user.telegramId, msg, { parse_mode: 'HTML' }).catch(() => {});
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[StopLoss] Error in stop loss monitor loop:', err);
  }
}

// Run Stop Loss check immediately at startup, then every 20 seconds
checkStopLoss();
setInterval(checkStopLoss, 20000);
