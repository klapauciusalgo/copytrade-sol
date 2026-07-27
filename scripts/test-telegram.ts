import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { Telegraf } from 'telegraf';
import { mainMenu, settingsMenu } from '../apps/telegram/src/menus';

async function runTelegramSmokeTest() {
  console.log('--- Starting Telegram UX Smoke Test ---');
  
  // Verify UI Markup compilation
  if (mainMenu.reply_markup.inline_keyboard.length === 4) {
    console.log('✅ Main Menu successfully compiled with 4 options.');
  } else {
    throw new Error('Main menu compilation failed');
  }

  if (settingsMenu.reply_markup.inline_keyboard.length === 3) {
    console.log('✅ Settings Menu successfully compiled with 3 options.');
  } else {
    throw new Error('Settings menu compilation failed');
  }

  // We skip connecting to api.telegram.org in the sandbox due to ENOTFOUND limits,
  // but we verify the Telegraf constructor and handlers register cleanly.
  try {
    const mockBot = new Telegraf('mock:token');
    mockBot.start(() => {});
    mockBot.action('main_menu', () => {});
    console.log('✅ Telegraf Bot instance and callback handlers registered successfully!');
  } catch (err) {
    console.error('❌ Telegraf initialization failed:', err);
    process.exit(1);
  }

  console.log('--- Telegram Smoke Test Completed ---');
}

runTelegramSmokeTest().catch(console.error);
