import { PrismaClient } from '@copytrade/database';
import * as dotenv from 'dotenv';
dotenv.config();

const prisma = new PrismaClient();
async function wipe() {
  await prisma.copyTarget.deleteMany();
  await prisma.wallet.deleteMany();
  console.log('Wallets and Targets wiped successfully');
}
wipe();
