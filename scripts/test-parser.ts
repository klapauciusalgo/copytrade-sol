import { Connection } from '@solana/web3.js';
import { parseTransaction } from '../packages/blockchain/src/parser';

const connection = new Connection('https://api.mainnet-beta.solana.com');

async function testTransaction(signature: string, wallet: string, label: string) {
  console.log(`\n--- Testing ${label} ---`);
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) {
    console.log('Transaction not found');
    return;
  }

  const result = parseTransaction(tx, wallet);
  console.log(`Action:  ${result.action}`);
  console.log(`Token:   ${result.token}`);
  console.log(`Amount:  ${result.amount}`);
  if (result.action !== 'TRANSFER') {
    console.log(`Price:   ${result.price} SOL`);
  }
}

async function main() {
  const TARGET_WALLET = '8zkgFGVZrDLieViwqiXFCydSX6WL5hsxmUu55yBdsNsZ';
  
  // 1. Buy TX
  await testTransaction('2mBbMHCuVhbH5k33iQJMrZu8b5fhwad3DuHnAt7BnJ9jYmWGHrTCrtLT4Ht9HCP6X3LJXJei4F6AUbgFfwfZSGtv', TARGET_WALLET, 'BUY TX');
  
  // 2. Sell TX
  await testTransaction('3CuuYLU7Tbx2qd5skuCcT2hJtLCzuqxz2cESRdhaRtoVnvYrTPE2trCihQTC6PtE13XR5xBDX7kw7BmWeDwaP8rs', TARGET_WALLET, 'SELL TX');
  
  // We don't have a specific transfer tx right now, but the logic is enforced for FEE_THRESHOLD.
}

main().catch(console.error);
