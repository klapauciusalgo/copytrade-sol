import { CopyTarget } from '@copytrade/database';
import { NormalizedEvent } from '@copytrade/blockchain';

export function calculatePositionSize(
  event: NormalizedEvent,
  targetRule: CopyTarget
): number {
  if (targetRule.strategy === 'FIXED') {
    // Fixed amount of SOL per trade (e.g. always buy 0.1 SOL)
    return targetRule.fixedAmount || 0.1;
  } else if (targetRule.strategy === 'RATIO') {
    // Ratio relative to the target's trade size
    // e.g., Target buys 10 SOL, ratio is 0.1, we buy 1 SOL
    const targetSpentSol = event.amount * event.price; 
    return targetSpentSol * (targetRule.ratio || 1.0);
  }
  return 0;
}
