/**
 * Canonical form of an iMessage / SMS handle. Emails are lower-cased. Phone numbers keep every digit,
 * with a bare 10-digit number read as US (+1), so "+1 (555) 000-1111" and "5550001111" match but
 * "+44 555 000 1111" does not. Comparing only the last 10 digits would let a foreign number that
 * shares them pass as the user.
 */
export function normalizeHandle(handle: string): string {
  const h = handle.trim().toLowerCase();
  if (h.includes('@')) return h.replace(/^mailto:/, '');
  const digits = h.replace(/\D/g, '');
  return digits.length === 10 ? `1${digits}` : digits;
}

export function sameHandle(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeHandle(a);
  return na.length > 0 && na === normalizeHandle(b);
}
