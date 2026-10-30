/** Timezone helpers built on Intl so the hub's notion of "today" matches the user's, not the server's. */

function parts(date: Date, tz: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

/** Minutes east of UTC for `tz` at `date` (e.g. -240 for EDT). */
export function offsetMinutes(date: Date, tz: string): number {
  const p = parts(date, tz);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

export function offsetString(date: Date, tz: string): string {
  const m = offsetMinutes(date, tz);
  const sign = m < 0 ? '-' : '+';
  const abs = Math.abs(m);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function localDateKey(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function startOfLocalDay(date: Date, tz: string): Date {
  const p = parts(date, tz);
  const guess = Date.UTC(+p.year, +p.month - 1, +p.day) - offsetMinutes(date, tz) * 60_000;
  // Re-derive the offset at midnight itself in case a DST switch happened during the day.
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) - offsetMinutes(new Date(guess), tz) * 60_000);
}

/** ISO-8601 with the local offset, e.g. 2026-10-29T21:58:00-04:00. Models reason about this far better than UTC. */
export function localIso(date: Date, tz: string): string {
  const p = parts(date, tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offsetString(date, tz)}`;
}

export function formatLocal(date: Date, tz: string, opts: { withDay?: boolean } = {}): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: opts.withDay === false ? undefined : 'short',
    month: opts.withDay === false ? undefined : 'short',
    day: opts.withDay === false ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}
