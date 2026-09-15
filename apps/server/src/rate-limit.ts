export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  private readonly windowMs: number;
  private readonly maxAttempts: number;

  constructor(options: { windowMs?: number; maxAttempts?: number } = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  consume(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    current.count += 1;
    if (current.count > this.maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }
}
