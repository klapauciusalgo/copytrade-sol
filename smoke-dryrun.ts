/**
 * Self-contained Smoke Test for DryRunEngine
 * Creates its own test data and cleans up after
 */
import * as dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({ path: resolve(__dirname, '.env') });

import { PrismaClient } from '@copytrade/database';
import { DryRunEngine } from '@copytrade/execution';

const prisma = new PrismaClient();
const engine = new DryRunEngine();

const TEST_TELEGRAM_ID = 'SMOKE_TEST_' + Date.now();
const TARGET_ADDRESS   = 'SMOKE_TARGET_ADDR_111111111111111111111111111';
const TOKEN_MINT       = 'SMOKE_TOKEN_MINT_1111111111111111111111111111';
const TOKEN_SYMBOL     = 'SMOKE';

async function setup() {
  const user = await prisma.user.create({
    data: {
      telegramId: TEST_TELEGRAM_ID,
      username: 'smoke_test',
      settings: { create: { dryRunEquitySol: 2.0 } }
    },
    include: { wallets: true, settings: true }
  });

  const wallet = await prisma.wallet.create({
    data: {
      userId: user.id,
      publicKey: 'SMOKE_PUBKEY_' + Date.now(),
      encryptedSecret: 'test',
      iv: 'test'
    }
  });

  return { user, wallet };
}

async function cleanup(userId: string, walletId: string) {
  await prisma.dryRunPosition.deleteMany({ where: { walletId } });
  await prisma.wallet.delete({ where: { id: walletId } });
  await prisma.userSettings.delete({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

async function run() {
  console.log('\n=== DRY RUN ENGINE SMOKE TEST ===\n');

  const { user, wallet } = await setup();
  const userId   = user.id;
  const walletId = wallet.id;
  console.log(`✅ Setup: created test user ${TEST_TELEGRAM_ID}, wallet ${wallet.id}`);

  let passed = 0;
  let failed = 0;

  const check = (label: string, ok: boolean, detail?: string) => {
    if (ok) { console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`); passed++; }
    else     { console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
  };

  try {
    // ── TEST 1: BUY ───────────────────────────────────────────────────────────
    console.log('\n[1] BUY 0.1 SOL worth of tokens');
    const r1 = await engine.processBuy(
      walletId, userId, TARGET_ADDRESS, TOKEN_MINT, TOKEN_SYMBOL,
      0.1, 1_000_000, 0.0000001
    );
    check('not skipped', !r1.skipped, r1.skipReason);
    check('remaining equity = 1.9 SOL', Math.abs((r1.remainingEquitySol ?? 0) - 1.9) < 0.001,
      `got ${r1.remainingEquitySol}`);
    check('virtualSolSpent = 0.1', Math.abs((r1.virtualSolSpent ?? 0) - 0.1) < 0.001);

    // ── TEST 2: Second BUY same token (averaging down) ────────────────────────
    console.log('\n[2] Second BUY same token (averaging down)');
    const r2 = await engine.processBuy(
      walletId, userId, TARGET_ADDRESS, TOKEN_MINT, TOKEN_SYMBOL,
      0.05, 400_000, 0.000000125
    );
    check('not skipped', !r2.skipped);
    check('remaining equity = 1.85 SOL', Math.abs((r2.remainingEquitySol ?? 0) - 1.85) < 0.001,
      `got ${r2.remainingEquitySol}`);
    const pos = await prisma.dryRunPosition.findUnique({
      where: { walletId_targetAddress_tokenMint: { walletId, targetAddress: TARGET_ADDRESS, tokenMint: TOKEN_MINT } }
    });
    check('position merged: total spent = 0.15', pos != null && Math.abs(pos.virtualSolSpent - 0.15) < 0.001,
      `got ${pos?.virtualSolSpent}`);
    check('position merged: total tokens = 1.4M', pos != null && Math.abs(pos.tokenAmount - 1_400_000) < 1,
      `got ${pos?.tokenAmount}`);

    // ── TEST 3: SELL with profit ───────────────────────────────────────────────
    console.log('\n[3] SELL at +50% price');
    const avgEntry   = pos!.buyPriceSol;
    const sellPrice  = avgEntry * 1.5;
    const r3 = await engine.processSell(
      walletId, userId, TARGET_ADDRESS, TOKEN_MINT, TOKEN_SYMBOL, sellPrice
    );
    check('not skipped', !r3.skipped, r3.skipReason);
    check('P&L positive', (r3.pnlSol ?? 0) > 0, `pnl=${r3.pnlSol?.toFixed(6)}`);
    check('P&L% ≈ 50%', Math.abs((r3.pnlPercent ?? 0) - 50) < 2, `got ${r3.pnlPercent?.toFixed(1)}%`);
    check('position closed', (await prisma.dryRunPosition.findUnique({
      where: { walletId_targetAddress_tokenMint: { walletId, targetAddress: TARGET_ADDRESS, tokenMint: TOKEN_MINT } }
    })) === null);

    // ── TEST 4: SELL with no open position ────────────────────────────────────
    console.log('\n[4] SELL token with no open position');
    const r4 = await engine.processSell(
      walletId, userId, TARGET_ADDRESS, 'NONEXISTENT_TOKEN_00000000000000000000000000', 'NOPE', 0.001
    );
    check('correctly skipped', r4.skipped);
    check('skip reason present', !!r4.skipReason);

    // ── TEST 5: BUY exceeding virtual equity ──────────────────────────────────
    console.log('\n[5] BUY more than available equity');
    await prisma.userSettings.update({ where: { userId }, data: { dryRunEquitySol: 0.01 } });
    const r5 = await engine.processBuy(
      walletId, userId, TARGET_ADDRESS, TOKEN_MINT, TOKEN_SYMBOL,
      5.0, 1000, 0.005
    );
    check('correctly skipped (insufficient equity)', r5.skipped);
    check('skip reason mentions equity', (r5.skipReason ?? '').includes('equity'));

    // ── TEST 6: Reset portfolio ────────────────────────────────────────────────
    console.log('\n[6] Reset portfolio');
    await prisma.userSettings.update({ where: { userId }, data: { dryRunEquitySol: 2.0 } });
    // Add a position first
    await engine.processBuy(walletId, userId, TARGET_ADDRESS, TOKEN_MINT, TOKEN_SYMBOL, 0.1, 1000, 0.0001);
    const beforeCount = await prisma.dryRunPosition.count({ where: { walletId } });
    await engine.resetPortfolio(walletId, userId, 2.0);
    const afterCount = await prisma.dryRunPosition.count({ where: { walletId } });
    const settingsAfter = await prisma.userSettings.findUnique({ where: { userId } });
    check('positions cleared', beforeCount > 0 && afterCount === 0, `before=${beforeCount} after=${afterCount}`);
    check('equity restored to 2.0', Math.abs((settingsAfter?.dryRunEquitySol ?? 0) - 2.0) < 0.001);

    // ── RESULT ────────────────────────────────────────────────────────────────
    console.log(`\n${'='.repeat(40)}`);
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    if (failed === 0) console.log('✅ ALL TESTS PASSED');
    else console.error(`❌ ${failed} TEST(S) FAILED`);

  } finally {
    await cleanup(userId, walletId);
    console.log('\n🧹 Test data cleaned up');
    await prisma.$disconnect();
    process.exit(failed > 0 ? 1 : 0);
  }
}

run().catch(async (e) => {
  console.error('❌ FATAL:', e);
  await prisma.$disconnect();
  process.exit(1);
});
