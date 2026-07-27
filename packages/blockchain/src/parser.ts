import { ParsedTransactionWithMeta } from '@solana/web3.js';

export interface NormalizedEvent {
  wallet: string;
  action: 'BUY' | 'SELL' | 'SWAP' | 'TRANSFER' | 'UNKNOWN';
  token: string;
  amount: number;
  price: number; // Price in terms of SOL (or base token)
  slot: number;
  signature: string;
}

const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Parses a Solana transaction by analyzing the net balance changes of the target wallet.
 * This is highly robust because it works across all DEXs (Jupiter, Raydium, Pump.fun)
 * without needing specific program IDLs. It just looks at what went in and out of the wallet.
 */
export function parseTransaction(
  tx: ParsedTransactionWithMeta,
  targetWallet: string
): NormalizedEvent {
  const signature = tx.transaction.signatures[0];
  const slot = tx.slot;
  
  // Skip failed transactions
  if (!tx.meta || tx.meta.err) {
    return createUnknownEvent(targetWallet, slot, signature);
  }

  const preBalances = tx.meta.preTokenBalances || [];
  const postBalances = tx.meta.postTokenBalances || [];

  const getWalletBalances = (balances: typeof preBalances) => 
    balances.filter(b => b.owner === targetWallet);

  const pre = getWalletBalances(preBalances);
  const post = getWalletBalances(postBalances);

  // Map to easily find net balance changes by token mint
  const balanceChanges = new Map<string, number>();

  // Subtract pre-balances
  for (const b of pre) {
    const amount = Number(b.uiTokenAmount.uiAmount || 0);
    balanceChanges.set(b.mint, -amount);
  }

  // Add post-balances
  for (const b of post) {
    const amount = Number(b.uiTokenAmount.uiAmount || 0);
    const current = balanceChanges.get(b.mint) || 0;
    balanceChanges.set(b.mint, current + amount);
  }

  // Calculate native SOL changes (used for network fees and native Swaps)
  // We compare the preBalances and postBalances arrays using the account index
  const accountIndex = tx.transaction.message.accountKeys.findIndex(
    (k: any) => k.pubkey.toString() === targetWallet
  );
  
  if (accountIndex !== -1) {
    const preSol = tx.meta.preBalances[accountIndex] / 1e9;
    const postSol = tx.meta.postBalances[accountIndex] / 1e9;
    const solChange = postSol - preSol;
    
    if (solChange !== 0) {
      const current = balanceChanges.get(NATIVE_SOL_MINT) || 0;
      balanceChanges.set(NATIVE_SOL_MINT, current + solChange);
    }
  }

  let action: NormalizedEvent['action'] = 'UNKNOWN';
  let primaryToken = '';
  let tokenAmount = 0;
  let price = 0;

  const solChange = balanceChanges.get(NATIVE_SOL_MINT) || 0;
  
  // Find the most significant token change that isn't SOL
  let targetMint = '';
  let maxChange = 0;

  for (const [mint, change] of balanceChanges.entries()) {
    if (mint !== NATIVE_SOL_MINT && Math.abs(change) > Math.abs(maxChange)) {
      targetMint = mint;
      maxChange = change;
    }
  }

  const FEE_THRESHOLD = 0.005; // 0.005 SOL max expected network fee
  
  // Determine the Action based on asset flow
  if (targetMint) {
    // BUY: Token went UP, and SOL went DOWN by more than just a fee
    if (maxChange > 0 && solChange < -FEE_THRESHOLD) {
      action = 'BUY';
      primaryToken = targetMint;
      tokenAmount = maxChange;
      price = Math.abs(solChange / maxChange);
    }
    // SELL: Token went DOWN, and SOL went UP
    else if (maxChange < 0 && solChange > 0) {
      action = 'SELL';
      primaryToken = targetMint;
      tokenAmount = Math.abs(maxChange);
      price = Math.abs(solChange / maxChange);
    }
    // TRANSFER: Token moved, but SOL barely changed (just network fees)
    else if (maxChange !== 0) {
      action = 'TRANSFER';
      primaryToken = targetMint;
      tokenAmount = Math.abs(maxChange);
    }
  }

  if (action === 'UNKNOWN') {
    return createUnknownEvent(targetWallet, slot, signature);
  }

  return {
    wallet: targetWallet,
    action,
    token: primaryToken,
    amount: tokenAmount,
    price,
    slot,
    signature
  };
}

function createUnknownEvent(wallet: string, slot: number, signature: string): NormalizedEvent {
  return {
    wallet,
    action: 'UNKNOWN',
    token: '',
    amount: 0,
    price: 0,
    slot,
    signature
  };
}
