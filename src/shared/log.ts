/**
 * Structured JSON-lines logger. Message content never reaches stdout: any field whose name suggests
 * a message body is replaced by its length, and long strings are truncated.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEYS = /^(text|body|payload|raw|raw_excerpt|rawExcerpt|message|messages|summary|transcript|content|digest|result|password|token|secret|authorization|cookie)$/i;
const MAX_STRING = 300;

export function redact(value: unknown, key = '', depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (key && SENSITIVE_KEYS.test(key)) {
    if (typeof value === 'string') return `[redacted ${value.length} chars]`;
    if (Array.isArray(value)) return `[redacted ${value.length} items]`;
    if (value && typeof value === 'object') return '[redacted object]';
  }
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message, '', depth + 1) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

let sink: (line: string, level: Level) => void = (line, level) => {
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
};

/** Tests swap the sink to capture output. */
export function setLogSink(fn: (line: string, level: Level) => void): () => void {
  const prev = sink;
  sink = fn;
  return () => {
    sink = prev;
  };
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const emit = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < (ORDER[process.env.LOG_LEVEL as Level] ?? ORDER.info)) return;
    const record = { ts: new Date().toISOString(), level, msg, ...(redact({ ...base, ...fields }) as object) };
    sink(JSON.stringify(record), level);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}

export const log = createLogger();
