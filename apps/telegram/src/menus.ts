import { Markup } from 'telegraf';

export const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('💼 My Portfolio', 'view_portfolio')],
  [Markup.button.callback('👛 Wallet Management', 'manage_wallet')],
  [Markup.button.callback('🎯 Target Wallets', 'manage_targets')],
  [Markup.button.callback('⚙️ Settings', 'view_settings')],
]);

export const walletMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🆕 Generate New Wallet', 'wallet_generate')],
  [Markup.button.callback('📥 Import Wallet', 'wallet_import')],
  [Markup.button.callback('📤 Export Private Key', 'wallet_export')],
  [Markup.button.callback('🗑️ Delete Wallet', 'wallet_delete')],
  [Markup.button.callback('🔙 Back to Main', 'main_menu')],
]);

export const confirmDeleteMenu = Markup.inlineKeyboard([
  [Markup.button.callback('⚠️ Yes, Delete My Wallet', 'wallet_delete_confirm')],
  [Markup.button.callback('🔙 No, Go Back', 'manage_wallet')],
]);

export const settingsMenu = Markup.inlineKeyboard([
  [Markup.button.callback('Set Slippage', 'set_slippage')],
  [Markup.button.callback('Set Priority Fee', 'set_fee')],
  [Markup.button.callback('🔙 Back to Main', 'main_menu')]
]);

export const backToMain = Markup.inlineKeyboard([
  [Markup.button.callback('🔙 Back to Main', 'main_menu')]
]);
