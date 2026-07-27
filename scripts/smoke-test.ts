import { PrismaClient } from '@copytrade/database';
import { encrypt, decrypt } from '@copytrade/common';
import { executionQueue } from '@copytrade/core';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env' });

async function runSmokeTest() {
  console.log('Starting Smoke Test...');
  const prisma = new PrismaClient();

  try {
    // 1. Test Database
    console.log('Testing Database connection...');
    const user = await prisma.user.create({
      data: {
        telegramId: 'smoke_test_' + Date.now(),
        username: 'smoke_user',
        settings: {
          create: {}
        }
      }
    });
    console.log(`✅ DB Success! Created user: ${user.id}`);

    // 2. Test Encryption
    console.log('Testing AES-256 Encryption...');
    const secretMessage = 'solana-private-key-test';
    const encrypted = encrypt(secretMessage);
    const decrypted = decrypt(encrypted.encryptedData, encrypted.iv);
    if (decrypted === secretMessage) {
      console.log(`✅ Encryption Success!`);
    } else {
      throw new Error('Encryption mismatch');
    }

    // 3. Test Queue (Redis)
    console.log('Testing Redis/BullMQ connection...');
    const job = await executionQueue.add('testJob', { foo: 'bar' });
    console.log(`✅ Queue Success! Enqueued job ID: ${job.id}`);

  } catch (error) {
    console.error('❌ Smoke Test Failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
    // BullMQ close
    await executionQueue.close();
    console.log('Smoke Test Completed.');
    process.exit(0);
  }
}

runSmokeTest();
