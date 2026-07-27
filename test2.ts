import { PrismaClient } from '@copytrade/database';
import { decrypt, encrypt } from '@copytrade/common';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// Force dotenv load from exactly where index.ts loads it
dotenv.config({ path: resolve(__dirname, '.env') });

const prisma = new PrismaClient();

async function run() {
  const wallets = await prisma.wallet.findMany();
  if (wallets.length === 0) {
    console.log('No wallets in DB!');
    return;
  }
  const w = wallets[0];
  console.log('Trying to decrypt with process.env.ENCRYPTION_KEY=', process.env.ENCRYPTION_KEY);
  console.log(`Wallet encryptedSecret: ${w.encryptedSecret}`);
  console.log(`Wallet iv: ${w.iv}`);
  try {
    const d = decrypt(w.encryptedSecret, w.iv);
    console.log('SUCCESS:', d);
  } catch (err: any) {
    console.error('FAIL DECRYPT DB:', err.message);
  }
  
  // Now try to encrypt and decrypt manually
  try {
    const enc = encrypt('test-secret');
    const d = decrypt(enc.encryptedData, enc.iv);
    console.log('SELF TEST SUCCESS:', d);
  } catch (err: any) {
    console.error('FAIL SELF TEST:', err.message);
  }
}
run();
