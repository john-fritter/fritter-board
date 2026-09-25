/**
 * Counts failed logins per username and refuses further attempts once a
 * username passes the limit, until its window expires. In memory: a restart
 * resets it, which is acceptable for a small board behind one process.
 */
export class LoginLimiter {
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  private key(username: string): string {
    return username.trim().toLowerCase();
  }

  isBlocked(username: string): boolean {
    const entry = this.failures.get(this.key(username));
    if (!entry) return false;
    if (entry.resetAt <= this.now()) {
      this.failures.delete(this.key(username));
      return false;
    }
    return entry.count >= this.maxFailures;
  }

  recordFailure(username: string): void {
    const key = this.key(username);
    const entry = this.failures.get(key);
    if (!entry || entry.resetAt <= this.now()) {
      this.failures.set(key, { count: 1, resetAt: this.now() + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  recordSuccess(username: string): void {
    this.failures.delete(this.key(username));
  }
}
