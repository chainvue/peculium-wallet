/**
 * A non-reentrant, non-blocking in-process flag shared across the money
 * gates. Both `WalletGate` (on-chain) and `PaymentGate` (off-chain paid
 * fetch) acquire the SAME instance so at most one money operation — and
 * therefore at most one pending human elicitation — is ever in flight at a
 * time. Without a shared lock a `wallet_send` awaiting human confirmation
 * could run concurrently with a `wallet_paid_fetch` confirmation, driving
 * two prompts through one host where the human might approve the wrong one.
 *
 * `tryAcquire` never blocks: contention returns false and the caller denies
 * (queuing would run an intent against a world the caller no longer sees).
 */
export class SpendLock {
  private held = false;

  tryAcquire(): boolean {
    if (this.held) {
      return false;
    }
    this.held = true;
    return true;
  }

  release(): void {
    this.held = false;
  }
}
