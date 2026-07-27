import { Connection } from '@solana/web3.js';

const connection = new Connection('https://api.mainnet-beta.solana.com');

async function checkTx(signature: string, label: string) {
  console.log(`\n--- ${label} ---`);
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  
  if (!tx || !tx.meta) {
    console.log('Transaction not found or no meta');
    return;
  }

  console.log('Fee:', tx.meta.fee);
  
  const accountKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toString());
  const signer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey.toString();
  console.log('Signer (Likely Wallet):', signer);

  const signerIndex = accountKeys.indexOf(signer!);
  const preSol = tx.meta.preBalances[signerIndex] / 1e9;
  const postSol = tx.meta.postBalances[signerIndex] / 1e9;
  console.log(`Native SOL Change for ${signer}: ${postSol - preSol}`);

  const preToken = tx.meta.preTokenBalances?.filter(b => b.owner === signer) || [];
  const postToken = tx.meta.postTokenBalances?.filter(b => b.owner === signer) || [];

  console.log('Token Balance Changes:');
  const changes = new Map<string, number>();
  
  preToken.forEach(b => {
    changes.set(b.mint, -(Number(b.uiTokenAmount.uiAmount || 0)));
  });

  postToken.forEach(b => {
    const cur = changes.get(b.mint) || 0;
    changes.set(b.mint, cur + Number(b.uiTokenAmount.uiAmount || 0));
  });

  for (const [mint, change] of changes.entries()) {
    if (change !== 0) {
      console.log(`Mint: ${mint}, Change: ${change}`);
    }
  }
}

async function main() {
  await checkTx('2mBbMHCuVhbH5k33iQJMrZu8b5fhwad3DuHnAt7BnJ9jYmWGHrTCrtLT4Ht9HCP6X3LJXJei4F6AUbgFfwfZSGtv', 'BUY TX');
  await checkTx('3CuuYLU7Tbx2qd5skuCcT2hJtLCzuqxz2cESRdhaRtoVnvYrTPE2trCihQTC6PtE13XR5xBDX7kw7BmWeDwaP8rs', 'SELL TX');
}

main().catch(console.error);
