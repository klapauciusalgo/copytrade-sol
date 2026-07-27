import { Connection, PublicKey } from '@solana/web3.js';
import { executionQueue } from '@copytrade/core';

export class WalletMonitor {
  private connection: Connection;
  private watchedWallets: Set<string> = new Set();
  private subscriptionIds: Map<string, number> = new Map();

  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  async startWatching(walletAddress: string) {
    if (this.watchedWallets.has(walletAddress)) return;

    console.log(`Starting to monitor wallet: ${walletAddress}`);
    const pubKey = new PublicKey(walletAddress);
    this.watchedWallets.add(walletAddress);

    // Subscribe to logs for this wallet
    const subId = this.connection.onLogs(
      pubKey,
      (logs, ctx) => {
        if (logs.err) return; // Skip failed transactions
        this.processEvent(walletAddress, logs.signature, ctx.slot);
      },
      'confirmed'
    );
    this.subscriptionIds.set(walletAddress, subId);
  }

  async stopWatching(walletAddress: string) {
    const subId = this.subscriptionIds.get(walletAddress);
    if (subId !== undefined) {
      await this.connection.removeOnLogsListener(subId);
      this.subscriptionIds.delete(walletAddress);
      this.watchedWallets.delete(walletAddress);
      console.log(`Stopped monitoring wallet: ${walletAddress}`);
    }
  }

  private async processEvent(wallet: string, signature: string, slot: number) {
    // In production, we fetch the parsed transaction here
    // For now, we push the raw signature to the execution queue for the worker to process
    console.log(`Detected event for ${wallet}: ${signature}`);
    
    await executionQueue.add('processTransaction', {
      wallet,
      signature,
      slot
    });
  }
}
