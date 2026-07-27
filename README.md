# Solana Telegram Copy-Trading Bot 🚀

A highly modular and robust Solana copy-trading bot integrated with Telegram. It leverages the Jupiter API for execution, BullMQ for robust job processing, and Helius/Native RPC for real-time blockchain monitoring.

## ✨ Features

- **Automated Copy Trading:** Instantly copy buys and sells from target wallets.
- **Monitor Mode (Watch Only):** Track a wallet's activity and receive Telegram alerts with real-time USD/SOL values without risking your own capital.
- **Wallet Encryption:** User wallet secrets are encrypted at rest using AES-256-CBC.
- **Microservice Architecture:** Separated Telegram UI and Worker backend, communicating via Redis and BullMQ.
- **Robust Parsing:** Analyzes raw token balance changes to determine buys and sells across *any* DEX (Raydium, Pump.fun, Jupiter, etc.) without requiring specific program IDLs.

## 🏗️ Architecture

This repository is built using a monorepo structure (npm workspaces):

- `apps/telegram`: The frontend Telegram Bot UI. Handles user registration, wallet generation, and target management.
- `apps/worker`: The background execution engine. Listens to blockchain events, processes the BullMQ queue, and executes trades via Jupiter.
- `packages/database`: Prisma ORM schema and database client.
- `packages/blockchain`: Blockchain transaction parser and wallet monitor.
- `packages/execution`: Decision engine, risk management, and Jupiter execution logic.
- `packages/common`: Shared utilities (like encryption).

## 📋 Prerequisites

Before you begin, ensure you have the following installed:
- [Node.js](https://nodejs.org/en/) (v18 or higher)
- [PostgreSQL](https://www.postgresql.org/) (Running and accessible)
- [Redis](https://redis.io/) (Running and accessible)

You will also need:
- A Telegram Bot Token from [@BotFather](https://t.me/botfather).
- (Optional but recommended) A fast RPC URL or [Helius API Key](https://helius.dev/) for reliable Solana node access.

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
   Create a `.env` file in the root directory based on `.env.example`:
   ```bash
   cp .env.example .env
   ```
   *Make sure to configure the following in your `.env` file:*
   - `DATABASE_URL`: Your PostgreSQL connection string.
   - `REDIS_URL`: Your Redis connection string (default: `redis://localhost:6379`).
   - `TELEGRAM_BOT_TOKEN`: Your bot token from BotFather.
   - `ENCRYPTION_KEY`: A completely random 32-character string used to encrypt private keys.
   - `SOLANA_RPC_URL`: Your Solana RPC endpoint.

4. **Initialize the Database:**
   Sync the Prisma schema with your PostgreSQL database:
   ```bash
   cd packages/database
   npx prisma db push
   cd ../..
   ```

5. **Build the project:**
   Compile the TypeScript packages:
   ```bash
   npm run build
   ```

## 🏃 Running the Bot

Because of the microservice architecture, you need to run both the Telegram UI and the Worker backend simultaneously. 

**Terminal 1 (Telegram Bot):**
```bash
npx tsx apps/telegram/src/index.ts
```

**Terminal 2 (Worker Engine):**
```bash
npx tsx apps/worker/src/index.ts
```

## 🛠️ Usage

1. Open Telegram and search for your bot.
2. Send `/start` to initialize your account.
3. Your bot will automatically generate a new Solana wallet for you (which is securely encrypted).
4. Click **Target Wallets** and reply with the Solana address you wish to copy.
5. Use the **🔄 Toggle Mode** button to switch between **COPY** (auto-execute trades) and **MONITOR** (alert only).
6. Ensure your bot's wallet is funded with a small amount of SOL for network fees and trading.

## ⚠️ Disclaimer

Trading cryptocurrencies, especially newly launched tokens on DEXs, is extremely risky. This software is provided "as is", without warranty of any kind. Use at your own risk. Always test in Monitor Mode with small amounts before fully copying a wallet.
