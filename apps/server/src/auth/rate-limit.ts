/** Sliding-window limiter kept in memory (single server). Keys look like `code:email` or `ip:1.2.3.4`. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()

  /** Record one hit; returns false when `max` hits already happened within `windowMs`. */
  take(key: string, max: number, windowMs: number, at = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter(time => at - time < windowMs)
    if (recent.length >= max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(at)
    this.hits.set(key, recent)
    if (this.hits.size > 50_000) this.prune(at, windowMs)
    return true
  }

  private prune(at: number, windowMs: number): void {
    for (const [key, times] of this.hits) if (times.every(time => at - time >= windowMs)) this.hits.delete(key)
  }
}
