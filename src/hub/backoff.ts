/** Exponential backoff with jitter, capped. attempt is 1-based. */
export function backoffMs(attempt: number, baseMs: number, capMs = 60 * 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}
