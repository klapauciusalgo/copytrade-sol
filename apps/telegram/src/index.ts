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

import { mainMenu, walletMenu, confirmDeleteMenu, settingsMenu, backToMain } from './menus';

// In-memory session store for multi-step interactions (import wallet)
const userSessions = new Map<string, { state: string }>();

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
  const telegramId = ctx.from?.id.toString() || '';
  try {
    const { text } = await getLivePortfolioMessage(telegramId);
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...backToMain
    }).catch(() => {});
  } catch (e) {
    await ctx.editMessageText('❌ Failed to fetch live portfolio.', {
      parse_mode: 'HTML',
      ...backToMain
    }).catch(() => {});
  }
});

bot.action('manage_wallet', async (ctx) => {
  const telegramId = ctx.from?.id.toString() || '';
  const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: true } });
  
  let walletText = '👛 <b>Wallet Management</b>\n\n';
  if (user && user.wallets.length > 0) {
    const pubKeyStr = user.wallets[0].publicKey;
    let balanceSol = '0.0000';
    try {
      const heliusKey = process.env.HELIUS_API_KEY;
      const rpcUrl = (heliusKey && heliusKey !== 'your_helius_api_key_here') 
        ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
        : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

      const connection = new Connection(rpcUrl, 'confirmed');
      const balanceRaw = await connection.getBalance(new PublicKey(pubKeyStr));
      balanceSol = (balanceRaw / 1e9).toFixed(4);
    } catch (e) {
      console.error('Error fetching balance for wallet management:', e);
    }

    walletText += `<b>Active Wallet:</b>\n<code>${pubKeyStr}</code>\n\n💰 <b>Live Balance:</b> <b>${balanceSol} SOL</b>\n\n<i>Fund this address with SOL to pay for live trades and gas fees.</i>`;
  } else {
    walletText += 'No wallet found. Generate a new one or import an existing wallet.';
  }
  
  await ctx.editMessageText(walletText, {
    parse_mode: 'HTML',
    ...walletMenu
  }).catch(() => {});
});

// Generate wallet from menu button
bot.action('wallet_generate', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.answerCbQuery('Error: Unknown Telegram ID.');

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: true } });

  if (user && user.wallets.length > 0) {
    await ctx.answerCbQuery('You already have an active wallet!');
    return ctx.editMessageText(
      `⚠️ <b>Wallet already exists!</b>\n\n<code>${user.wallets[0].publicKey}</code>\n\n<i>Export your current key first before generating a new one.</i>`,
      { parse_mode: 'HTML', ...walletMenu }
    ).catch(() => {});
  }

  await ctx.answerCbQuery('Generating wallet...');

  const keypair = Keypair.generate();
  const pubKey = keypair.publicKey.toBase58();
  const secretStr = bs58.encode(keypair.secretKey);
  const { encryptedData, iv } = encrypt(secretStr);

  await prisma.wallet.create({
    data: { userId: user!.id, publicKey: pubKey, encryptedSecret: encryptedData, iv }
  });

  await ctx.editMessageText(
    `✅ <b>Wallet Generated!</b>\n\nPublic Key:\n<code>${pubKey}</code>\n\n<i>Fund this address with SOL before adding copy targets.</i>`,
    { parse_mode: 'HTML', ...walletMenu }
  ).catch(() => {});
});

// Trigger import flow
bot.action('wallet_import', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.answerCbQuery();

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: true } });
  if (user && user.wallets.length > 0) {
    await ctx.answerCbQuery('You already have an active wallet!');
    return ctx.editMessageText(
      `⚠️ <b>Wallet already exists!</b>\n\n<code>${user.wallets[0].publicKey}</code>\n\nYou currently cannot import while a wallet is active. Export and delete it first.`,
      { parse_mode: 'HTML', ...walletMenu }
    ).catch(() => {});
  }

  userSessions.set(telegramId, { state: 'awaiting_private_key' });
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '📥 <b>Import Wallet</b>\n\n🔐 Please send your <b>Base58 private key</b> in the next message.\n\n⚠️ <i>This message will be processed securely and your key will be encrypted immediately. Never share your private key with anyone.</i>\n\n<i>Send /cancel to abort.</i>',
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
  ).catch(() => {});
});

// Export wallet from menu button
bot.action('wallet_export', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.answerCbQuery();

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: true } });
  if (!user || user.wallets.length === 0) {
    await ctx.answerCbQuery('No wallet to export!');
    return;
  }

  const wallet = user.wallets[0];
  try {
    const privateKey = decrypt(wallet.encryptedSecret, wallet.iv);
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      `⚠️ <b>DANGER ZONE</b> ⚠️\n\nHere is your Private Key. <b>DO NOT SHARE THIS WITH ANYONE!</b>\nAnyone with this key can steal all your funds.\n\n<code>${privateKey}</code>\n\n<i>Import this key into Phantom or Solflare.</i>`
    );
  } catch (err) {
    await ctx.answerCbQuery('Decryption failed!');
  }
});

// Show delete confirmation screen
bot.action('wallet_delete', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.answerCbQuery();

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: true } });
  if (!user || user.wallets.length === 0) {
    await ctx.answerCbQuery('No wallet to delete!');
    return;
  }

  const pubKey = user.wallets[0].publicKey;
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `🗑️ <b>Delete Wallet</b>\n\n⚠️ <b>Are you absolutely sure?</b>\n\nThis will permanently delete your wallet and <b>ALL copy targets</b> linked to it from this bot.\n\n<b>Wallet:</b>\n<code>${pubKey}</code>\n\n<i>Your on-chain funds are NOT affected — make sure you have backed up your private key before deleting.</i>`,
    { parse_mode: 'HTML', ...confirmDeleteMenu }
  ).catch(() => {});
});

// Execute the actual deletion
bot.action('wallet_delete_confirm', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.answerCbQuery();

  try {
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: { include: { copyTargets: true } } } });
    if (!user || user.wallets.length === 0) {
      await ctx.answerCbQuery('No wallet found!');
      return;
    }

    const walletId = user.wallets[0].id;

    // Delete all copy targets first (foreign key constraint)
    await prisma.copyTarget.deleteMany({ where: { walletId } });
    // Delete the wallet
    await prisma.wallet.delete({ where: { id: walletId } });

    await ctx.answerCbQuery('Wallet deleted.');
    await ctx.editMessageText(
      `✅ <b>Wallet Deleted.</b>\n\nYour wallet and all associated copy targets have been removed from this bot.\n\nUse <b>👛 Wallet Management</b> to generate or import a new wallet.`,
      { parse_mode: 'HTML', ...walletMenu }
    ).catch(() => {});
  } catch (err) {
    console.error('Delete wallet error:', err);
    await ctx.answerCbQuery('Failed to delete wallet.');
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
      const mode = (t as any).mode || 'COPY';
      const modeEmoji: Record<string, string> = { COPY: '📋', MONITOR: '👁️', DRY_RUN: '🧪' };
      const strategy = t.strategy || 'FIXED';
      const sizeLabel = strategy === 'FIXED'
        ? `📌 ${t.fixedAmount ?? 0.1} SOL`
        : `📊 ${((t.ratio ?? 1) * 100).toFixed(0)}% of target`;
      targetText += `${i+1}. <code>${t.targetAddress}</code>\nMode: <b>${modeEmoji[mode]} ${mode}</b> | Size: <b>${sizeLabel}</b>\n`;
      inlineKeyboard.push([
        { text: `💼 Portfolio`, callback_data: `port_${t.targetAddress}` },
        { text: `🔄 Mode`, callback_data: `toggle_mode_${t.targetAddress}` },
        { text: `⚖️ Order Size`, callback_data: `target_settings_${t.targetAddress}` }
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

// ── Blocked Tokens Management ────────────────────────────────────────────────
async function renderBlockedTokensMenu(ctx: any) {
  const telegramId = ctx.from?.id.toString() || '';
  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { blockedTokens: true }
  });

  let text = '🚫 <b>Blocked Tokens List</b>\n\n';
  let inlineKeyboard: any[] = [];

  if (user && user.blockedTokens.length > 0) {
    text += '<i>The bot will automatically ignore and SKIP buying any tokens in this list:</i>\n\n';
    user.blockedTokens.forEach((t, i) => {
      const labelStr = t.label ? ` (${t.label})` : '';
      text += `${i + 1}. <code>${t.tokenAddress}</code>${labelStr}\n`;
      inlineKeyboard.push([
        { text: `🗑️ Unblock ${t.label || t.tokenAddress.slice(0, 6)}...`, callback_data: `unblock_${t.tokenAddress}` }
      ]);
    });
  } else {
    text += 'No tokens currently blocked.\n\n<i>To block a token, send:</i>\n<code>/blocktoken [address] [optional_name]</code>\n\n<i>Example:</i>\n<code>/blocktoken 8Jqs2Le4HsNUxfEWy44vQaDWrR3gqR3cvSJigDMcpump CallDog</code>';
  }

  inlineKeyboard.push([{ text: '🔙 Back to Main', callback_data: 'main_menu' }]);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    }).catch(() => {});
  } else {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard }
    });
  }
}

bot.action('manage_blocked_tokens', renderBlockedTokensMenu);
bot.command('blockedtokens', renderBlockedTokensMenu);

// ─── Target Order Size Settings ──────────────────────────────────────────────
bot.action(/^target_settings_(.+)$/, async (ctx) => {
  const targetAddress = ctx.match[1];
  const telegramId = ctx.from?.id.toString() || '';

  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: { include: { copyTargets: true } } }
  });
  if (!user || user.wallets.length === 0) return ctx.answerCbQuery('Wallet not found');
  const target = user.wallets[0].copyTargets.find((t: any) => t.targetAddress === targetAddress);
  if (!target) return ctx.answerCbQuery('Target not found');

  const strategy = target.strategy || 'FIXED';
  const currentFixed = target.fixedAmount ?? 0.1;
  const currentRatio = target.ratio ?? 0.1;

  const text = `⚖️ <b>Order Size Settings</b>\n\n` +
    `🎯 <b>Target:</b> <code>${targetAddress}</code>\n\n` +
    `<b>Current Strategy:</b> ${strategy === 'FIXED' ? '📌 Fixed Amount' : '📊 % of Target'}\n` +
    (strategy === 'FIXED'
      ? `<b>Amount:</b> ${currentFixed} SOL per trade\n`
      : `<b>Ratio:</b> ${(currentRatio * 100).toFixed(0)}% of target\'s buy size\n`) +
    `\n<b>Choose a strategy below:</b>`;

  await ctx.answerCbQuery();
  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '📌 Fixed Amount (SOL)', callback_data: `set_fixed_${targetAddress}` }],
        [{ text: '📊 % of Target\'s Buy', callback_data: `set_ratio_${targetAddress}` }],
        [{ text: '🔙 Back to Targets', callback_data: 'manage_targets' }]
      ]
    }
  }).catch(() => {});
});

// User selects Fixed strategy — prompt for SOL amount
bot.action(/^set_fixed_(.+)$/, async (ctx) => {
  const targetAddress = ctx.match[1];
  const telegramId = ctx.from?.id.toString() || '';
  userSessions.set(telegramId, { state: `awaiting_fixed_${targetAddress}` });
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `📌 <b>Fixed Amount Strategy</b>\n\nEnter the amount of <b>SOL</b> to use per trade.\n\n<i>Example: <code>0.1</code> means buy 0.1 SOL worth each time the target buys.</i>\n\nSend /cancel to abort.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
  ).catch(() => {});
});

// User selects Ratio strategy — prompt for percentage
bot.action(/^set_ratio_(.+)$/, async (ctx) => {
  const targetAddress = ctx.match[1];
  const telegramId = ctx.from?.id.toString() || '';
  userSessions.set(telegramId, { state: `awaiting_ratio_${targetAddress}` });
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `📊 <b>Percentage Strategy</b>\n\nEnter the <b>percentage</b> of the target\'s buy size to mirror.\n\n<i>Example: <code>10</code> means if the target buys 5 SOL, you buy 0.5 SOL (10%).</i>\n\nSend /cancel to abort.`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
  ).catch(() => {});
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

    const [stdAccounts, t2022Accounts] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID }).catch(() => ({ value: [] })),
      connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] }))
    ]);
    const tokenAccountsList = [...stdAccounts.value, ...t2022Accounts.value];
    
    let tokenText = '';
    let count = 0;
    
    for (const { account } of tokenAccountsList) {
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
  
  const dryEquity = user?.settings?.dryRunEquitySol ?? 1.0;
  const slippageDisplay = user?.settings?.defaultSlippage === 0 ? 'Auto' : `${user?.settings?.defaultSlippage || 1.0}%`;
  const stopLossDisplay = (user?.settings?.stopLossPercent ?? 20) === 0 ? 'Disabled' : `-${user?.settings?.stopLossPercent ?? 20}%`;
  const text = `⚙️ <b>Global Settings</b>\n\nSlippage: ${slippageDisplay}\nPriority Fee: ${user?.settings?.priorityFee || 0.001} SOL\n🛑 Stop Loss: ${stopLossDisplay}\n🧪 Dry Run Equity: ${dryEquity} SOL\n\n<i>Use these commands to update settings:\n/setstoploss [percent | off]\n/setslippage [value | auto]\n/setfee [value]\n/setdryequity [amount]</i>`;
  
  await ctx.editMessageText(text, {
    parse_mode: 'HTML',
    ...settingsMenu
  }).catch(() => {});
});

bot.action('set_slippage', (ctx) => {
  ctx.reply('To update your slippage, please send the command:\n<code>/setslippage [percentage]</code>\n\nExamples:\n<code>/setslippage 2.5</code> (for 2.5%)\n<code>/setslippage auto</code> (for dynamic Jupiter slippage)', { parse_mode: 'HTML' });
});

bot.action('set_fee', (ctx) => {
  ctx.reply('To update your priority fee, please send the command:\n<code>/setfee [amount_in_SOL]</code>\n\nExample: <code>/setfee 0.005</code>', { parse_mode: 'HTML' });
});

bot.action('set_stop_loss', (ctx) => {
  ctx.reply('To update your Stop Loss percentage, please send the command:\n<code>/setstoploss [percentage]</code>\n\nExamples:\n<code>/setstoploss 20</code> (auto sell if price drops 20%)\n<code>/setstoploss 15</code> (auto sell if price drops 15%)\n<code>/setstoploss off</code> (disable stop loss)', { parse_mode: 'HTML' });
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

// Cancel command for aborting multi-step flows
bot.command('cancel', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (telegramId && userSessions.has(telegramId)) {
    userSessions.delete(telegramId);
    return ctx.reply('❌ Action cancelled.');
  }
  return ctx.reply('Nothing to cancel.');
});

// Text listener — handles import private key AND adding target wallets
bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return next();

  const session = userSessions.get(telegramId);

  // ─── Handle Private Key Import ───────────────────────────────────────────
  if (session?.state === 'awaiting_private_key') {
    userSessions.delete(telegramId); // Clear session immediately

    // Attempt to delete user's message so private key isn't visible in chat
    await ctx.deleteMessage().catch(() => {});

    try {
      // Validate the key by trying to load it as a Keypair
      let secretBytes: Uint8Array;
      try {
        secretBytes = bs58.decode(text);
        if (secretBytes.length !== 64) throw new Error('Invalid length');
      } catch {
        return ctx.reply('❌ <b>Invalid private key!</b>\n\nMake sure you are sending a Base58-encoded private key (88 characters).', { parse_mode: 'HTML' });
      }

      const keypair = Keypair.fromSecretKey(secretBytes);
      const pubKey = keypair.publicKey.toBase58();
      const secretStr = bs58.encode(keypair.secretKey);
      const { encryptedData, iv } = encrypt(secretStr);

      const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: true } });
      if (!user) return ctx.reply('❌ User not found. Please send /start first.');
      if (user.wallets.length > 0) return ctx.reply('❌ You already have an active wallet. Cannot import.');

      // Check if this wallet is already registered to another user
      const existingWallet = await prisma.wallet.findUnique({ where: { publicKey: pubKey } });
      if (existingWallet) {
        return ctx.reply('❌ This wallet is already linked to an account.', { parse_mode: 'HTML' });
      }

      await prisma.wallet.create({
        data: { userId: user.id, publicKey: pubKey, encryptedSecret: encryptedData, iv }
      });

      return ctx.replyWithHTML(
        `✅ <b>Wallet Imported Successfully!</b>\n\nPublic Key:\n<code>${pubKey}</code>\n\n<i>Your private key has been encrypted and stored securely. Fund this address with SOL before adding copy targets.</i>`
      );
    } catch (err) {
      console.error('Import wallet error:', err);
      return ctx.reply('❌ Failed to import wallet. Please check your private key and try again.');
    }
  }

  // ─── Handle Fixed SOL Amount Input ───────────────────────────────────────
  if (session?.state?.startsWith('awaiting_fixed_')) {
    const targetAddress = session.state.replace('awaiting_fixed_', '');
    userSessions.delete(telegramId);

    const amount = parseFloat(text);
    if (isNaN(amount) || amount <= 0 || amount > 1000) {
      return ctx.reply('❌ Invalid amount. Please enter a positive number (e.g. <code>0.1</code>).', { parse_mode: 'HTML' });
    }

    const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: { include: { copyTargets: true } } } });
    if (!user || user.wallets.length === 0) return ctx.reply('❌ Wallet not found.');

    const target = user.wallets[0].copyTargets.find((t: any) => t.targetAddress === targetAddress);
    if (!target) return ctx.reply('❌ Target not found.');

    await prisma.copyTarget.update({
      where: { id: target.id },
      data: { strategy: 'FIXED', fixedAmount: amount, ratio: null }
    });

    return ctx.replyWithHTML(
      `✅ <b>Order Size Updated!</b>\n\n🎯 <b>Target:</b> <code>${targetAddress}</code>\n📌 <b>Strategy:</b> Fixed Amount\n💰 <b>Amount:</b> ${amount} SOL per trade`
    );
  }

  // ─── Handle Ratio (%) Input ───────────────────────────────────────────────
  if (session?.state?.startsWith('awaiting_ratio_')) {
    const targetAddress = session.state.replace('awaiting_ratio_', '');
    userSessions.delete(telegramId);

    const pct = parseFloat(text);
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      return ctx.reply('❌ Invalid percentage. Enter a number between <code>0.1</code> and <code>100</code>.', { parse_mode: 'HTML' });
    }

    const ratio = pct / 100;
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: { include: { copyTargets: true } } } });
    if (!user || user.wallets.length === 0) return ctx.reply('❌ Wallet not found.');

    const target = user.wallets[0].copyTargets.find((t: any) => t.targetAddress === targetAddress);
    if (!target) return ctx.reply('❌ Target not found.');

    await prisma.copyTarget.update({
      where: { id: target.id },
      data: { strategy: 'RATIO', ratio, fixedAmount: null }
    });

    return ctx.replyWithHTML(
      `✅ <b>Order Size Updated!</b>\n\n🎯 <b>Target:</b> <code>${targetAddress}</code>\n📊 <b>Strategy:</b> ${pct}% of target's buy\n\n<i>Example: if target buys 10 SOL, you buy ${(10 * ratio).toFixed(2)} SOL.</i>`
    );
  }

  // ─── Handle Solana Address → Add Copy Target ─────────────────────────────
  const solanaAddressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (solanaAddressRegex.test(text)) {
    const user = await prisma.user.findUnique({ where: { telegramId }, include: { wallets: true }});
    
    if (!user || user.wallets.length === 0) {
      return ctx.reply('❌ You must generate or import a wallet first before adding targets.');
    }
    
    const walletId = user.wallets[0].id;
    
    const existing = await prisma.copyTarget.findFirst({ where: { walletId, targetAddress: text } });
    if (existing) {
      return ctx.reply(`⚠️ Target <code>${text}</code> is already in your active list.`, { parse_mode: 'HTML' });
    }
    
    await prisma.copyTarget.create({
      data: { walletId, targetAddress: text, status: 'ACTIVE', strategy: 'FIXED', fixedAmount: 0.1 }
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
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

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

    // Fetch SPL Tokens (Both Standard & Token-2022)
    const [stdAccounts, t2022Accounts] = await Promise.all([
      connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID }).catch(() => ({ value: [] })),
      connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] }))
    ]);
    const tokenAccountsList = [...stdAccounts.value, ...t2022Accounts.value];
    
    let tokenText = '';
    let count = 0;
    
    for (const { account } of tokenAccountsList) {
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

  // Rotate: COPY → MONITOR → DRY_RUN → COPY
  const modeOrder = ['COPY', 'MONITOR', 'DRY_RUN'];
  const currentIdx = modeOrder.indexOf((target as any).mode || 'COPY');
  const newMode = modeOrder[(currentIdx + 1) % modeOrder.length];

  await prisma.copyTarget.update({
    where: { id: target.id },
    data: { mode: newMode as any }
  });

  await ctx.answerCbQuery(`Mode changed to ${newMode}`);
  
  // Refresh the menu
  const modeEmoji: Record<string, string> = { COPY: '📋', MONITOR: '👁️', DRY_RUN: '🧪' };
  let targetText = '🎯 <b>Target Wallets</b>\n\n<b>Active Targets:</b>\n';
  let inlineKeyboard: any[] = [];
  
  const updatedUser = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: { include: { copyTargets: true } } }
  });
  
  if (updatedUser && updatedUser.wallets.length > 0) {
    updatedUser.wallets[0].copyTargets.forEach((t: any, i: number) => {
      const mode = t.mode || 'COPY';
      targetText += `${i+1}. <code>${t.targetAddress}</code>\nStatus: ${t.status} | Mode: <b>${modeEmoji[mode] || ''} ${mode}</b>\n`;
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

// /dryportfolio — show virtual open positions with live market valuation
bot.command('dryportfolio', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: { include: { dryRunPositions: true } }, settings: true }
  });

  if (!user || user.wallets.length === 0) {
    return ctx.reply('❌ No wallet found. Use /start first.');
  }

  const positions = user.wallets[0].dryRunPositions;
  const equity = (user.settings as any)?.dryRunEquitySol ?? 1.0;

  if (positions.length === 0) {
    const msg = `🧪 <b>Dry Run Portfolio</b>\n\n💰 <b>Available Virtual Equity:</b> ${equity.toFixed(4)} SOL\n📈 <b>Open Positions Value:</b> 0.0000 SOL\n💼 <b>Total Net Worth:</b> ${equity.toFixed(4)} SOL\n\n<i>No open positions. Start tracking a target in DRY_RUN mode!</i>`;
    return ctx.replyWithHTML(msg, {
      reply_markup: {
        inline_keyboard: [[{ text: '🔄 Reset Dry Run Portfolio', callback_data: 'dryrun_reset' }]]
      }
    });
  }

  const statusMsg = await ctx.reply('⏳ Calculating live valuation for held tokens & P&L...');

  // Get current SOL price
  let solPriceUsd = 150;
  try {
    const solRes = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112').catch(() => null);
    if (solRes) {
      const data = await solRes.json();
      const solPair = data.pairs?.find((p: any) => p.chainId === 'solana' && (p.quoteToken.symbol === 'USDC' || p.quoteToken.symbol === 'USDT'));
      if (solPair?.priceUsd) solPriceUsd = parseFloat(solPair.priceUsd);
    }
  } catch (e) {}

  let totalPositionsValueSol = 0;
  let totalSpentSol = 0;
  let positionsText = '';

  // Fetch live prices for held tokens
  await Promise.all(
    positions.map(async (pos) => {
      let currentPriceSol = pos.buyPriceSol;
      try {
        const tokenRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pos.tokenMint}`).catch(() => null);
        if (tokenRes) {
          const data = await tokenRes.json();
          const pair = data.pairs?.find((p: any) => p.chainId === 'solana') || data.pairs?.[0];
          if (pair?.priceNative) {
            currentPriceSol = parseFloat(pair.priceNative);
          }
        }
      } catch (e) {}

      const currentValueSol = pos.tokenAmount * currentPriceSol;
      totalPositionsValueSol += currentValueSol;
      totalSpentSol += pos.virtualSolSpent;

      const pnlSol = currentValueSol - pos.virtualSolSpent;
      const pnlPercent = pos.virtualSolSpent > 0 ? (pnlSol / pos.virtualSolSpent) * 100 : 0;
      const pnlEmoji = pnlSol >= 0 ? '🟢' : '🔴';
      const pnlSign = pnlSol >= 0 ? '+' : '';

      const short = `${pos.tokenMint.slice(0, 4)}...${pos.tokenMint.slice(-4)}`;
      const symbol = pos.tokenSymbol || short;

      positionsText += `\n🪙 <b>${symbol}</b>\n   Spent: ${pos.virtualSolSpent.toFixed(4)} SOL → Current: <b>${currentValueSol.toFixed(4)} SOL</b>\n   ${pnlEmoji} P&L: <b>${pnlSign}${pnlSol.toFixed(4)} SOL (${pnlSign}${pnlPercent.toFixed(1)}%)</b>\n`;
    })
  );

  const totalNetWorthSol = equity + totalPositionsValueSol;
  const netWorthUsd = (totalNetWorthSol * solPriceUsd).toFixed(2);
  const openPositionsUsd = (totalPositionsValueSol * solPriceUsd).toFixed(2);

  const totalPnlSol = totalPositionsValueSol - totalSpentSol;
  const totalPnlPercent = totalSpentSol > 0 ? (totalPnlSol / totalSpentSol) * 100 : 0;
  const overallPnlEmoji = totalPnlSol >= 0 ? '🟢' : '🔴';
  const overallPnlSign = totalPnlSol >= 0 ? '+' : '';

  let msg = `🧪 <b>Dry Run Portfolio & Valuation</b>\n\n`;
  msg += `💼 <b>Total Net Worth:</b> <b>${totalNetWorthSol.toFixed(4)} SOL</b> ($${netWorthUsd})\n`;
  msg += `💰 <b>Available Virtual SOL:</b> ${equity.toFixed(4)} SOL\n`;
  msg += `📈 <b>Held Tokens Value:</b> ${totalPositionsValueSol.toFixed(4)} SOL ($${openPositionsUsd})\n`;
  msg += `${overallPnlEmoji} <b>Unrealized P&L:</b> <b>${overallPnlSign}${totalPnlSol.toFixed(4)} SOL (${overallPnlSign}${totalPnlPercent.toFixed(1)}%)</b>\n\n`;
  msg += `<b>Held Tokens (${positions.length}):</b>\n${positionsText}`;
  msg += `\n<i>To reset portfolio, use the button below.</i>`;

  await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, msg, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🔄 Reset Dry Run Portfolio', callback_data: 'dryrun_reset' }]]
    }
  }).catch(() => {});
});

// Helper for fetching live production portfolio
async function getLivePortfolioMessage(telegramId: string) {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: { include: { copyTargets: true } } }
  });

  if (!user || user.wallets.length === 0) {
    return { text: '❌ No wallet found. Use /start first.' };
  }

  const pubKeyStr = user.wallets[0].publicKey;
  const activeTargetsCount = user.wallets[0].copyTargets.filter(t => t.status === 'ACTIVE').length;

  const heliusKey = process.env.HELIUS_API_KEY;
  const rpcUrl = (heliusKey && heliusKey !== 'your_helius_api_key_here') 
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
    : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

  const connection = new Connection(rpcUrl, 'confirmed');
  const pubKey = new PublicKey(pubKeyStr);

  // Fetch Native SOL Balance
  const solBalanceRaw = await connection.getBalance(pubKey);
  const solBalance = solBalanceRaw / 1e9;

  // Fetch SOL price in USD
  let solPriceUsd = 150;
  try {
    const solRes = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112').catch(() => null);
    if (solRes) {
      const data = await solRes.json();
      const solPair = data.pairs?.find((p: any) => p.chainId === 'solana' && (p.quoteToken.symbol === 'USDC' || p.quoteToken.symbol === 'USDT'));
      if (solPair?.priceUsd) solPriceUsd = parseFloat(solPair.priceUsd);
    }
  } catch (e) {}

  // Fetch SPL Tokens (Both Standard SPL & Token-2022 used by Pump.fun)
  const [stdAccounts, t2022Accounts] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_PROGRAM_ID }).catch(() => ({ value: [] })),
    connection.getParsedTokenAccountsByOwner(pubKey, { programId: TOKEN_2022_PROGRAM_ID }).catch(() => ({ value: [] }))
  ]);
  
  const activeTokens = [...stdAccounts.value, ...t2022Accounts.value]
    .map(a => a.account.data.parsed.info)
    .filter(info => info.tokenAmount.uiAmount > 0);

  let totalTokensValueSol = 0;
  let tokensText = '';

  await Promise.all(
    activeTokens.map(async (info) => {
      const mint = info.mint;
      const uiAmount = info.tokenAmount.uiAmount;
      let priceNativeSol = 0;
      let symbol = `${mint.slice(0, 4)}...${mint.slice(-4)}`;

      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`).catch(() => null);
        if (res) {
          const data = await res.json();
          const pair = data.pairs?.find((p: any) => p.chainId === 'solana') || data.pairs?.[0];
          if (pair) {
            if (pair.baseToken?.symbol) symbol = pair.baseToken.symbol;
            if (pair.priceNative) priceNativeSol = parseFloat(pair.priceNative);
          }
        }
      } catch (e) {}

      const tokenValSol = uiAmount * priceNativeSol;
      const tokenValUsd = tokenValSol * solPriceUsd;
      totalTokensValueSol += tokenValSol;

      const formattedAmount = uiAmount >= 10000 ? uiAmount.toLocaleString('en-US', { maximumFractionDigits: 0 }) : uiAmount.toFixed(2);
      tokensText += `\n🪙 <b>${symbol}</b>\n   Balance: ${formattedAmount} → Value: <b>${tokenValSol.toFixed(4)} SOL</b> ($${tokenValUsd.toFixed(2)})\n`;
    })
  );

  if (tokensText === '') tokensText = '<i>No SPL tokens currently held.</i>\n';

  const totalNetWorthSol = solBalance + totalTokensValueSol;
  const netWorthUsd = (totalNetWorthSol * solPriceUsd).toFixed(2);
  const solBalanceUsd = (solBalance * solPriceUsd).toFixed(2);
  const tokensValUsd = (totalTokensValueSol * solPriceUsd).toFixed(2);

  let msg = `🚀 <b>Live Production Portfolio</b>\n\n`;
  msg += `🔑 <b>Wallet:</b> <code>${pubKeyStr}</code>\n`;
  msg += `💼 <b>Total Net Worth:</b> <b>${totalNetWorthSol.toFixed(4)} SOL</b> ($${netWorthUsd})\n`;
  msg += `💰 <b>SOL Balance:</b> <b>${solBalance.toFixed(4)} SOL</b> ($${solBalanceUsd})\n`;
  msg += `🪙 <b>Held Tokens Value:</b> ${totalTokensValueSol.toFixed(4)} SOL ($${tokensValUsd})\n`;
  msg += `🎯 <b>Active Targets:</b> ${activeTargetsCount}\n\n`;
  msg += `<b>Held Tokens (${activeTokens.length}):</b>\n${tokensText}\n`;
  msg += `🔗 <a href="https://solscan.io/account/${pubKeyStr}">View on Solscan</a>`;

  return { text: msg };
}

// /liveportfolio & /myportfolio commands
bot.command(['liveportfolio', 'myportfolio'], async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const statusMsg = await ctx.reply('⏳ Fetching live production portfolio & token valuations...');
  try {
    const { text } = await getLivePortfolioMessage(telegramId);
    await ctx.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    });
  } catch (e) {
    ctx.reply('❌ Failed to fetch live portfolio.');
  }
});

// /setdryequity — set virtual equity
bot.command('setdryequity', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const args = ctx.message.text.split(' ');
  const amount = parseFloat(args[1]);

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply('❌ Invalid amount.\n\nUsage: <code>/setdryequity 2.5</code>\nExample sets virtual equity to 2.5 SOL.', { parse_mode: 'HTML' });
  }

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { settings: true } });
  if (!user || !user.settings) {
    return ctx.reply('❌ User settings not found. Please send /start first.');
  }

  await prisma.userSettings.update({
    where: { userId: user.id },
    data: { dryRunEquitySol: amount }
  });

  return ctx.replyWithHTML(`✅ <b>Dry Run Equity Updated!</b>\n\nVirtual equity set to <b>${amount} SOL</b>.\n\n<i>Note: This only changes your available equity. Open positions are not affected. Use /dryportfolio to reset.</i>`);
});

bot.command('setslippage', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const args = ctx.message.text.split(' ');
  const input = args[1]?.toLowerCase();
  let amount = 0;

  if (input !== 'auto') {
    amount = parseFloat(input);
    if (isNaN(amount) || amount <= 0 || amount > 100) {
      return ctx.reply('❌ Invalid percentage.\n\nUsage: <code>/setslippage 2.5</code> or <code>/setslippage auto</code>\nExample sets slippage to 2.5%.', { parse_mode: 'HTML' });
    }
  }

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { settings: true } });
  if (!user || !user.settings) {
    return ctx.reply('❌ User settings not found. Please send /start first.');
  }

  await prisma.userSettings.update({
    where: { userId: user.id },
    data: { defaultSlippage: amount }
  });

  const display = amount === 0 ? 'Auto (Dynamic)' : `${amount}%`;
  return ctx.replyWithHTML(`✅ <b>Slippage Updated!</b>\n\nDefault slippage set to <b>${display}</b>.`);
});

bot.command('setfee', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const args = ctx.message.text.split(' ');
  const amount = parseFloat(args[1]);

  if (isNaN(amount) || amount < 0) {
    return ctx.reply('❌ Invalid amount.\n\nUsage: <code>/setfee 0.005</code>\nExample sets priority fee to 0.005 SOL.', { parse_mode: 'HTML' });
  }

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { settings: true } });
  if (!user || !user.settings) {
    return ctx.reply('❌ User settings not found. Please send /start first.');
  }

  await prisma.userSettings.update({
    where: { userId: user.id },
    data: { priorityFee: amount }
  });

  return ctx.replyWithHTML(`✅ <b>Priority Fee Updated!</b>\n\nDefault priority fee set to <b>${amount} SOL</b>.`);
});

bot.command('setstoploss', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const args = ctx.message.text.split(' ');
  const input = args[1]?.toLowerCase();
  let amount = 0;

  if (input !== 'off' && input !== '0') {
    amount = parseFloat(input);
    if (isNaN(amount) || amount <= 0 || amount > 95) {
      return ctx.reply('❌ Invalid percentage.\n\nUsage: <code>/setstoploss 20</code> or <code>/setstoploss off</code>\nExample sets Stop Loss to -20%.', { parse_mode: 'HTML' });
    }
  }

  const user = await prisma.user.findUnique({ where: { telegramId }, include: { settings: true } });
  if (!user || !user.settings) {
    return ctx.reply('❌ User settings not found. Please send /start first.');
  }

  await prisma.userSettings.update({
    where: { userId: user.id },
    data: { stopLossPercent: amount }
  });

  const display = amount === 0 ? 'Disabled' : `-${amount}%`;
  return ctx.replyWithHTML(`✅ <b>Stop Loss Updated!</b>\n\nStop Loss trigger set to <b>${display}</b>.`);
});

bot.command('blocktoken', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const args = ctx.message.text.split(' ');
  const tokenAddress = args[1]?.trim();
  const label = args.slice(2).join(' ') || undefined;

  if (!tokenAddress || tokenAddress.length < 30) {
    return ctx.reply('❌ Invalid Token Address.\n\nUsage: <code>/blocktoken [address] [optional_name]</code>\nExample: <code>/blocktoken 8Jqs2Le4HsNUxfEWy44vQaDWrR3gqR3cvSJigDMcpump CallDog</code>', { parse_mode: 'HTML' });
  }

  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) {
    return ctx.reply('❌ User not found. Please send /start first.');
  }

  await prisma.blockedToken.upsert({
    where: {
      userId_tokenAddress: {
        userId: user.id,
        tokenAddress
      }
    },
    create: {
      userId: user.id,
      tokenAddress,
      label
    },
    update: {
      label
    }
  });

  const labelMsg = label ? ` (${label})` : '';
  return ctx.replyWithHTML(`✅ <b>Token Blocked Successfully!</b>\n\nToken: <code>${tokenAddress}</code>${labelMsg}\n\n<i>The bot will now automatically ignore and SKIP buying this token.</i>`);
});

bot.command('unblocktoken', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return;

  const args = ctx.message.text.split(' ');
  const tokenAddress = args[1]?.trim();

  if (!tokenAddress) {
    return ctx.reply('❌ Usage: <code>/unblocktoken [address]</code>', { parse_mode: 'HTML' });
  }

  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) return;

  await prisma.blockedToken.deleteMany({
    where: {
      userId: user.id,
      tokenAddress
    }
  });

  return ctx.replyWithHTML(`✅ Token <code>${tokenAddress}</code> unblocked.`);
});

bot.action(/^unblock_(.+)$/, async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.answerCbQuery();

  const tokenAddress = ctx.match[1];
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (!user) return ctx.answerCbQuery();

  await prisma.blockedToken.deleteMany({
    where: {
      userId: user.id,
      tokenAddress
    }
  });

  await ctx.answerCbQuery('Token unblocked!');
  return renderBlockedTokensMenu(ctx);
});

// Reset dry run portfolio
bot.action('dryrun_reset', async (ctx) => {
  const telegramId = ctx.from?.id.toString();
  if (!telegramId) return ctx.answerCbQuery();

  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { wallets: true, settings: true }
  });

  if (!user || user.wallets.length === 0) {
    return ctx.answerCbQuery('No wallet found!');
  }

  const walletId = user.wallets[0].id;
  const resetEquity = (user.settings as any)?.dryRunEquitySol ?? 1.0;

  // Close all open positions and restore equity to current configured value
  await prisma.dryRunPosition.deleteMany({ where: { walletId } });

  await ctx.answerCbQuery('Portfolio reset!');
  await ctx.editMessageText(
    `✅ <b>Dry Run Portfolio Reset!</b>\n\nAll open positions have been closed.\nVirtual equity restored to <b>${resetEquity.toFixed(4)} SOL</b>.\n\n<i>Use /setdryequity to change the equity amount.</i>`,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
  ).catch(() => {});
});

bot.launch().then(() => {
  console.log('Telegram bot is running...');
});
