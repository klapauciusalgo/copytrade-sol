import { Telegraf } from 'telegraf';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// Load root .env file
dotenv.config({ path: resolve(__dirname, '../../../.env') });

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken || botToken === 'your_bot_token') {
  console.error('TELEGRAM_BOT_TOKEN is not set in .env');
  process.exit(1);
}

const bot = new Telegraf(botToken);
const prisma = new PrismaClient();

import { mainMenu, settingsMenu, backToMain } from './menus';

bot.start(async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  const username = ctx.from?.username;

  if (!telegramId) {
    return ctx.reply('Could not resolve your Telegram ID.');
  }

  // User Management
  let user = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: true, settings: true }
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        telegramId,
        username,
        settings: { create: {} }
      },
      include: { wallets: true, settings: true }
    });
  }

  const welcomeText = `🚀 <b>Welcome to Solana CopyTrade Bot</b>, @${username || 'Trader'}!\n\nYour automated sniper is ready. Select an option below to manage your operations:`;
  
  await ctx.replyWithHTML(welcomeText, mainMenu);
});

// Callback Handlers
bot.action('main_menu', async (ctx) => {
  await ctx.editMessageText('🚀 <b>Main Menu</b>\n\nSelect an option below:', {
    parse_mode: 'HTML',
    ...mainMenu
  }).catch(() => {});
});

bot.action('view_portfolio', async (ctx) => {
  await ctx.editMessageText('💼 <b>Your Portfolio</b>\n\nBalance: 0.00 SOL\nActive Copies: 0', {
    parse_mode: 'HTML',
    ...backToMain
  }).catch(() => {});
});

bot.action('manage_wallet', async (ctx) => {
  const telegramId = ctx.from?.id.toString() || '';
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: true } });
  
  if (user && user.wallets.length > 0) {
    const pubKey = user.wallets[0].publicKey;
    await ctx.editMessageText(`👛 <b>Wallet Management</b>\n\nActive Wallet:\n<code>${pubKey}</code>\n\n<i>Fund this address with SOL to pay for trades and fees.</i>`, {
      parse_mode: 'HTML',
      ...backToMain
    }).catch(() => {});
  } else {
    await ctx.editMessageText('👛 <b>Wallet Management</b>\n\nNo active wallets found. Use /generate to create one.', {
      parse_mode: 'HTML',
      ...backToMain
    }).catch(() => {});
  }
});

bot.action('manage_targets', async (ctx) => {
  const telegramId = ctx.from?.id.toString() || '';
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: { include: { copyTargets: true } } } });
  
  let targetText = '🎯 <b>Target Wallets</b>\n\n';
  let inlineKeyboard: any[] = [];
  
  if (user && user.wallets.length > 0 && user.wallets[0].copyTargets.length > 0) {
    targetText += '<b>Active Targets:</b>\n';
    user.wallets[0].copyTargets.forEach((t, i) => {
      targetText += `${i+1}. <code>${t.targetAddress}</code>\nStatus: ${t.status} | Mode: <b>${(t as any).mode || 'COPY'}</b>\n`;
      inlineKeyboard.push([
        { text: `💼 Target ${i+1} Portfolio`, callback_data: `port_${t.targetAddress}` },
        { text: `🔄 Toggle Mode`, callback_data: `toggle_mode_${t.targetAddress}` }
      ]);
    });
    targetText += '\n<i>To add a new target, simply reply with their Solana Address in this chat.</i>';
  } else {
    targetText += 'You have no active targets.\n\n<i>To add a new target, simply reply with their Solana Address in this chat.</i>';
  }

  inlineKeyboard.push([{ text: '🔙 Back to Main', callback_data: 'main_menu' }]);

  await ctx.editMessageText(targetText, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: inlineKeyboard }
  }).catch(() => {});
});

bot.action(/^port_(.+)$/, async (ctx) => {
  const targetAddress = ctx.match[1];
  await ctx.editMessageText('⏳ Fetching portfolio from Helius RPC...', { parse_mode: 'HTML' }).catch(() => {});
  
  try {
    const heliusKey = process.env.HELIUS_API_KEY;
    const rpcUrl = (heliusKey && heliusKey !== 'your_helius_api_key_here') 
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

    const connection = new Connection(rpcUrl, 'confirmed');
    const pubKey = new PublicKey(targetAddress);

    const solBalanceRaw = await connection.getBalance(pubKey);
    const solBalance = (solBalanceRaw / 1e9).toFixed(4);

    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID });
    
    let tokenText = '';
    let count = 0;
    
    for (const { account } of tokenAccounts.value) {
      const parsedInfo = account.data.parsed.info;
      const amount = parsedInfo.tokenAmount.uiAmount;
      if (amount > 0) {
        const mint = parsedInfo.mint;
        const shortMint = `${mint.slice(0, 4)}...${mint.slice(-4)}`;
        tokenText += `• <b>${shortMint}</b>: ${amount}\n`;
        count++;
        if (count >= 15) {
          tokenText += `<i>...and more</i>\n`;
          break;
        }
      }
    }

    if (tokenText === '') tokenText = '<i>No tokens found.</i>';

    const finalMsg = `💼 <b>Portfolio for</b>\n<code>${targetAddress}</code>\n\n<b>SOL Balance:</b> ${solBalance} SOL\n\n<b>Tokens (Top 15):</b>\n${tokenText}\n\n🔗 <a href="https://solscan.io/account/${targetAddress}">View on Solscan</a>`;

    await ctx.editMessageText(finalMsg, { 
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back to Targets', callback_data: 'manage_targets' }]]
      }
    }).catch(() => {});
  } catch (err) {
    console.error('Portfolio error:', err);
    await ctx.editMessageText('❌ Invalid address or API error while fetching portfolio.', {
      reply_markup: {
        inline_keyboard: [[{ text: '🔙 Back to Targets', callback_data: 'manage_targets' }]]
      }
    }).catch(() => {});
  }
});

bot.action('view_settings', async (ctx) => {
  const telegramId = ctx.from?.id.toString() || '';
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { settings: true }});
  
  const text = `⚙️ <b>Global Settings</b>\n\nSlippage: ${user?.settings?.defaultSlippage || 1.0}%\nPriority Fee: ${user?.settings?.priorityFee || 0.001} SOL`;
  
  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...settingsMenu
  }).catch(() => {});
});

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { encrypt, decrypt } from '@copytrade/common';

bot.command('generate', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.reply('Error: Unknown Telegram ID.');

  try {
    // Check if user already has a wallet
    const user = await prisma.user.findUnique({
      where: { telegramId },
      include: { wallets: true }
    });

    if (user && user.wallets.length > 0) {
      return ctx.reply('⚠️ You already have an active wallet:\n<code>' + user.wallets[0].publicKey + '</code>', { parse_mode: 'HTML' });
    }

    ctx.reply('⏳ Generating your secure Solana wallet...');

    // Generate Wallet
    const keypair = Keypair.generate();
    const pubKey = keypair.publicKey.toBase58();
    const secretStr = bs58.encode(keypair.secretKey);

    // Encrypted Private Key
    const { encryptedData, iv } = encrypt(secretStr);

    // Save to Database
    await prisma.wallet.create({
      data: {
        userId: user!.id,
        publicKey: pubKey,
        encryptedSecret: encryptedData,
        iv: iv
      }
    });

    const successMsg = `✅ <b>Wallet Successfully Generated!</b>\n\nPublic Key:\n<code>${pubKey}</code>\n\n⚠️ <i>Please fund this wallet with some SOL to cover trading fees before adding copy targets.</i>`;
    
    await ctx.replyWithHTML(successMsg);

  } catch (err) {
    console.error('Failed to generate wallet:', err);
    ctx.reply('❌ An error occurred while generating your wallet. Please try again later.');
  }
});

// Text listener for adding target wallets
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  const telegramId = ctx.from?.id.toString();
  
  // Quick regex for a Solana Base58 address (approximate)
  const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (solanaAddressRegex.test(text)) {
    if (!telegramId) return;
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: true }});
    
    if (!user || user.wallets.length === 0) {
      return ctx.reply('❌ You must /generate a wallet first before adding targets.');
    }
    
    const walletId = user.wallets[0].id;
    
    // Check if it exists
    const existing = await prisma.copyTarget.findFirst({
      where: { walletId, targetAddress: text }
    });
    
    if (existing) {
      return ctx.reply(`⚠️ Target <code>${text}</code> is already in your active list.`, { parse_mode: 'HTML' });
    }
    
    // Add new target
    await prisma.copyTarget.create({
      data: {
        walletId,
        targetAddress: text,
        status: 'ACTIVE',
        strategy: 'FIXED',
        fixedAmount: 0.1 // Default size
      }
    });
    
    return ctx.reply(`✅ <b>Target Added!</b>\n\nYou are now automatically copying:\n<code>${text}</code>\n\nDefault Trade Size: 0.1 SOL.`, { parse_mode: 'HTML' });
  }
  
  return next();
});

// Command to export Private Key
bot.command('export', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: true }
  });

  if (!user || user.wallets.length === 0) {
    return ctx.reply('❌ You do not have an active wallet. Use /generate first.');
  }

  const wallet = user.wallets[0];
  
  try {
    const privateKeyBase58 = decrypt(wallet.encryptedSecret, wallet.iv);
    const warning = `⚠️ <b>DANGER ZONE</b> ⚠️\n\nHere is your Private Key. <b>DO NOT SHARE THIS WITH ANYONE!</b> Anyone who has this key can steal all your funds.\n\nYou can import this key into Phantom or Solflare wallet.\n\n<code>${privateKeyBase58}</code>`;
    
    await ctx.replyWithHTML(warning);
  } catch (err) {
    console.error('Failed to decrypt wallet:', err);
    ctx.reply('❌ An error occurred while decrypting your wallet.');
  }
});

import { Connection, PublicKey } from '@solana/web3.js';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// Command to check a target's portfolio
bot.command('portfolio', async (ctx) => {
  const args = ctx.message.text.split(' ');
  const targetAddress = args[1];

  if (!targetAddress) {
    return ctx.reply('❌ Please provide a wallet address.\n\nUsage: <code>/portfolio &lt;address&gt;</code>', { parse_mode: 'HTML' });
  }

  try {
    const msgInfo = await ctx.reply('⏳ Fetching portfolio from Helius RPC...');
    
    // Use Helius if available, else fallback to default RPC
    const heliusKey = process.env.HELIUS_API_KEY;
    const rpcUrl = (heliusKey && heliusKey !== 'your_helius_api_key_here') 
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

    const connection = new Connection(rpcUrl, 'confirmed');
    const pubKey = new PublicKey(targetAddress);

    // Fetch Native SOL Balance
    const solBalanceRaw = await connection.getBalance(pubKey);
    const solBalance = (solBalanceRaw / 1e9).toFixed(4);

    // Fetch SPL Tokens
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID });
    
    let tokenText = '';
    let count = 0;
    
    for (const { account } of tokenAccounts.value) {
      const parsedInfo = account.data.parsed.info;
      const amount = parsedInfo.tokenAmount.uiAmount;
      if (amount > 0) {
        const mint = parsedInfo.mint;
        const shortMint = `${mint.slice(0, 4)}...${mint.slice(-4)}`;
        tokenText += `• <b>${shortMint}</b>: ${amount}\n`;
        count++;
        if (count >= 15) {
          tokenText += `<i>...and more</i>\n`;
          break; // Limit to 15 tokens
        }
      }
    }

    if (tokenText === '') tokenText = '<i>No tokens found.</i>';

    const finalMsg = `💼 <b>Portfolio for</b>\n<code>${targetAddress}</code>\n\n<b>SOL Balance:</b> ${solBalance} SOL\n\n<b>Tokens (Top 15):</b>\n${tokenText}\n\n🔗 <a href="https://solscan.io/account/${targetAddress}">View on Solscan</a>`;

    await ctx.telegram.editMessageText(ctx.chat.id, msgInfo.message_id, undefined, finalMsg, { 
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    });

  } catch (err) {
    console.error('Portfolio error:', err);
    ctx.reply('❌ Invalid address or API error while fetching portfolio.');
  }
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bot.action(/^toggle_mode_(.+)$/, async (ctx) => {
  const targetAddress = ctx.match[1];
  const telegramId = ctx.from?.id.toString() || '';
  
  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: { include: { copyTargets: true } } }
  });

  if (!user || user.wallets.length === 0) return ctx.answerCbQuery('Wallet not found');
  const target = user.wallets[0].copyTargets.find((t: any) => t.targetAddress === targetAddress);
  if (!target) return ctx.answerCbQuery('Target not found');

  const newMode = (target as any).mode === 'MONITOR' ? 'COPY' : 'MONITOR';
  await prisma.copyTarget.update({
    where: { id: target.id },
    data: { mode: newMode as any }
  });

  await ctx.answerCbQuery(`Mode changed to ${newMode}`);
  
  // Refresh the menu
  let targetText = '🎯 <b>Target Wallets</b>\n\n<b>Active Targets:</b>\n';
  let inlineKeyboard: any[] = [];
  
  const updatedUser = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: { include: { copyTargets: true } } }
  });
  
  if (updatedUser && updatedUser.wallets.length > 0) {
    updatedUser.wallets[0].copyTargets.forEach((t: any, i: number) => {
      targetText += `${i+1}. <code>${t.targetAddress}</code>\nStatus: ${t.status} | Mode: <b>${t.mode || 'COPY'}</b>\n`;
      inlineKeyboard.push([
        { text: `💼 Target ${i+1} Portfolio`, callback_data: `port_${t.targetAddress}` },
        { text: `🔄 Toggle Mode`, callback_data: `toggle_mode_${t.targetAddress}` }
      ]);
    });
  }
  
  targetText += '\n<i>To add a new target, simply reply with their Solana Address in this chat.</i>';
  inlineKeyboard.push([{ text: '🔙 Back to Main', callback_data: 'main_menu' }]);

  await ctx.editMessageText(targetText, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: inlineKeyboard }
  }).catch(() => {});
});

bot.launch().then(() => {
  console.log('Telegram bot is running...');
});
