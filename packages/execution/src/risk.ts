import { CopyTarget, Wallet, UserSettings } from '@copytrade/database';

export interface ExecutionRequest {
  walletId: string;
  tokenMint: string;
  action: 'BUY' | 'SELL';
  amountSolIn?: number;
  amountTokenIn?: number;
  slippageBps: number;
  priorityFee: number;
  mode: 'COPY' | 'MONITOR' | 'DRY_RUN';
}

export function validateRisk(
  target: CopyTarget,
  wallet: Wallet,
  settings: UserSettings,
  tokenMint: string,
  proposedSolSize: number
): boolean {
  // Hardcoded for MVP, to be expanded in Phase 6
  const BLACKLIST = ['pump', 'fake'];
  if (BLACKLIST.some(b => tokenMint.includes(b) && b !== 'pump')) {
    console.warn(`Risk Validation Failed: Token ${tokenMint} is blacklisted.`);
    return false;
  }

  // Example check: Max trade size 5 SOL
  if (proposedSolSize > 5) {
    console.warn(`Risk Validation Failed: Proposed size ${proposedSolSize} exceeds 5 SOL limit.`);
    return false;
  }

  return true;
}
