import { describe, expect, it } from 'vitest';
import { createLogger, redact, setLogSink } from '../../src/shared/log.js';

describe('log redaction', () => {
  it('replaces message-body fields with their length, at any depth', () => {
    expect(
      redact({
        text: 'my midterm is friday',
        nested: { payload: 'secret plan', ok: 'visible' },
        list: [{ body: 'hello' }],
        messages: ['a', 'b'],
        raw_excerpt: 'x'.repeat(10),
        authorization: 'Bearer abc',
        cookie: { sid: 'abc' },
      }),
    ).toEqual({
      text: '[redacted 20 chars]',
      nested: { payload: '[redacted 11 chars]', ok: 'visible' },
      list: [{ body: '[redacted 5 chars]' }],
      messages: '[redacted 2 items]',
      raw_excerpt: '[redacted 10 chars]',
      authorization: '[redacted 10 chars]',
      cookie: '[redacted object]',
    });
  });

  it('truncates long strings, caps arrays, and survives deep or cyclic-looking input', () => {
    expect((redact({ note: 'y'.repeat(1000) }) as { note: string }).note).toHaveLength(301);
    expect((redact({ ids: Array.from({ length: 200 }, (_, i) => i) }) as { ids: number[] }).ids).toHaveLength(50);
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 20; i++) deep = { deep };
    expect(JSON.stringify(redact(deep))).toContain('[depth]');
  });

  it('keeps error names and messages', () => {
    expect(redact({ error: new TypeError('boom') })).toEqual({ error: { name: 'TypeError', message: 'boom' } });
  });

  it('never writes a message body through the logger', () => {
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    try {
      const log = createLogger({ component: 'test' }).child({ agent: 'instinct' });
      log.error('ingest', { text: 'TOP SECRET BODY', summary: 'ALSO SECRET', count: 3 });
    } finally {
      restore();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/SECRET/);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'error', msg: 'ingest', component: 'test', agent: 'instinct', count: 3 });
  });
});
