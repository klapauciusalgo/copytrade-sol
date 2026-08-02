# Solana Telegram Copy-Trading Bot 🚀

A highly modular, production-ready Solana copy-trading bot integrated with Telegram. It leverages Jupiter API v1 for execution, BullMQ for job queueing, Prisma ORM for database management, and Helius/Solana RPC for real-time blockchain monitoring.

---

## ✨ Key Features

- **Multi-Mode Trading:**
  - ⚡ **COPY (Live Mainnet):** Instantly copy buy and sell trades on Solana Mainnet using your encrypted wallet.
  - 🧪 **DRY_RUN (Paper Trading):** Test strategies in a simulated virtual environment with real-time PnL tracking without risking real SOL.
  - 👁️ **MONITOR (Watch Only):** Receive Telegram notifications of target wallet activity with USD/SOL values without executing trades.

- **Auto Slippage & Smart Execution:**
  - 📊 **Dynamic Auto Slippage:** Support for `/setslippage auto` leveraging Jupiter API dynamic slippage optimization (capped at 10% max).
  - 🛡️ **SELL Protection:** Enforces a minimum 3.0% slippage tolerance on `SELL` orders to prevent `0x1771` (Slippage Exceeded) simulation errors during fast price drops.
  - ⚡ **Priority Fee Customization:** Adjustable priority fee lamports to land transactions quickly on congested Solana blocks.

- **Automated Stop Loss Engine (Auto Sell):**
  - 🛑 **Real-time Price Monitoring:** Background worker scans held tokens (every 20s) comparing DexScreener prices with entry prices.
  - 📉 **Configurable Threshold:** Automatically executes a `SELL` order when token loss exceeds configured percentage (e.g. `/setstoploss 20` for -20%).

- **Token Blacklisting / Block List:**
  - 🚫 **Block Unwanted Tokens:** Easily blacklist token addresses (`/blocktoken`) to automatically skip buy orders for scam or unwanted tokens.

- **Token-2022 & Pump.fun Support:**
  - 🪙 **Full Token Program Support:** Queries both standard SPL Token (`TOKEN_PROGRAM_ID`) and Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) programs, capturing all Pump.fun memecoins and SPL tokens.

- **Live & Virtual Portfolio Dashboard:**
  - 💼 Real-time RPC wallet queries (`/liveportfolio`, `/myportfolio`, `/dryportfolio`) displaying SOL balance, SPL token holdings, and USD market valuations via DexScreener.

- **Wallet Security & AES-256 Encryption:**
  - 🔑 Private keys are encrypted at rest using AES-256-CBC with individual initialization vectors (IV).

---

## 🏗️ Architecture

This project is structured as a TypeScript monorepo using `npm workspaces`:

- `apps/telegram`: Telegram bot user interface (menus, command handlers, user settings).
- `apps/worker`: Background job processing queue and Stop Loss monitoring engine.
- `packages/database`: Prisma ORM schema and PostgreSQL client.
- `packages/blockchain`: Solana RPC transaction parser and real-time wallet monitor.
- `packages/execution`: Decision engine, position sizing, risk management, and Jupiter v1 swap executor.
- `packages/common`: Shared encryption and utility helpers.

---

## 📋 Prerequisites

Ensure you have installed:
- [Node.js](https://nodejs.org/en/) (v18 or higher)
- [PostgreSQL](https://www.postgresql.org/)
- [Redis](https://redis.io/)

Requirements:
- Telegram Bot Token from [@BotFather](https://t.me/botfather).
- Solana RPC URL (e.g. Helius, QuickNode, or official Mainnet RPC).

---

## 🚀 Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/klapauciusalgo/copytrade-sol.git
   cd copytrade-tg
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create `.env` file in the root directory:
   ```env
   DATABASE_URL="postgresql://user:password@localhost:5432/copytrade?schema=public"
   REDIS_URL="redis://localhost:6379"
   TELEGRAM_BOT_TOKEN="your_telegram_bot_token"
   ENCRYPTION_KEY="your_32_character_encryption_key"
   SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
   SIMULATE_TRADES="false"
   ```

4. **Initialize Database:**
   ```bash
   npx prisma db push --schema=packages/database/prisma/schema.prisma
   npx prisma generate --schema=packages/database/prisma/schema.prisma
   ```

5. **Build Projects:**
   ```bash
   npm run build
   ```

---

## 🏃 Running with PM2

Start both processes using PM2 or npm:

```bash
# Telegram Bot Process
npx pm2 start apps/telegram/dist/index.js --name copytrade-telegram

# Worker Process
npx pm2 start apps/worker/dist/index.js --name copytrade-worker
```

---

## 🤖 Telegram Commands Reference

| Command | Description | Example |
| :--- | :--- | :--- |
| `/start` | Initialize account and generate encrypted Solana wallet | `/start` |
| `/liveportfolio` | View live Mainnet SOL balance and SPL token holdings | `/liveportfolio` |
| `/dryportfolio` | View virtual paper trading portfolio and PnL metrics | `/dryportfolio` |
| `/setslippage [val]` | Set slippage percentage or enable auto dynamic slippage | `/setslippage auto` or `/setslippage 2.5` |
| `/setfee [sol]` | Set priority fee in SOL for transaction landing | `/setfee 0.002` |
| `/setstoploss [pct]`| Configure Auto Sell Stop Loss threshold percentage | `/setstoploss 20` or `/setstoploss off` |
| `/blocktoken [addr]`| Blacklist a token address to skip copy buying | `/blocktoken 8Jqs2L... CallDog` |
| `/unblocktoken [addr]`| Remove token address from blacklist | `/unblocktoken 8Jqs2L...` |
| `/blockedtokens` | View and manage blacklisted tokens list | `/blockedtokens` |
| `/setdryequity [sol]`| Set virtual starting equity SOL for paper trading | `/setdryequity 2.5` |

---

## ⚠️ Disclaimer

Trading cryptocurrencies and memecoins on Solana involves significant financial risk. This bot is provided for educational and experimental purposes. Always test in **MONITOR** or **DRY_RUN** mode before trading live funds on Mainnet. Use at your own risk.
