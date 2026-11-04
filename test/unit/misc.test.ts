import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPES, canSee } from '../../src/hub/scopes.js';
import { localDateKey, localIso, startOfLocalDay } from '../../src/hub/tz.js';
import { extractJson } from '../../src/hub/worker.js';
import { cleanTopics } from '../../src/hub/router.js';
import { normalizeHandle } from '../../src/hub/hub.js';

const scope = (agent: keyof typeof DEFAULT_SCOPES) => ({ agent, ...DEFAULT_SCOPES[agent] });

describe('scopes', () => {
  it('applies the v1 privacy defaults', () => {
    expect(canSee(scope('boardy'), ['networking'])).toBe(true);
    expect(canSee(scope('boardy'), ['networking', 'health'])).toBe(false);
    expect(canSee(scope('boardy'), ['school'])).toBe(false);
    expect(canSee(scope('stanley'), ['shoots', 'schedule'])).toBe(true);
    expect(canSee(scope('stanley'), ['plan'])).toBe(false);
    expect(canSee(scope('grok'), ['open_source'])).toBe(true);
    expect(canSee(scope('grok'), ['finances', 'work'])).toBe(false);
    expect(canSee(scope('instinct'), ['health', 'personal'])).toBe(true);
    expect(canSee(scope('claude'), ['school'])).toBe(true);
  });

  it('keeps untagged items private to wildcard agents', () => {
    expect(canSee(scope('boardy'), [])).toBe(false);
    expect(canSee(scope('claude'), [])).toBe(true);
    expect(canSee({ ...scope('claude'), enabled: false }, ['school'])).toBe(false);
  });
});

describe('tz', () => {
  it('computes local day boundaries across DST', () => {
    const tz = 'America/New_York';
    const evening = new Date('2026-10-30T01:30:00Z'); // 21:30 EDT on Oct 29
    expect(localDateKey(evening, tz)).toBe('2026-10-29');
    expect(startOfLocalDay(evening, tz).toISOString()).toBe('2026-10-29T04:00:00.000Z');
    expect(localIso(evening, tz)).toBe('2026-10-29T21:30:00-04:00');
    // Nov 1 2026: DST ends at 2am; midnight is still EDT.
    expect(startOfLocalDay(new Date('2026-11-01T20:00:00Z'), tz).toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });
});

describe('misc', () => {
  it('extracts JSON from fenced model output', () => {
    expect(extractJson('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"b": {"c": 2}}')).toEqual({ b: { c: 2 } });
  });

  it('restricts topics to the vocabulary', () => {
    expect(cleanTopics(['School', 'nonsense', 'school'])).toEqual(['school']);
    expect(cleanTopics([])).toEqual(['general']);
  });

  it('normalizes handles', () => {
    expect(normalizeHandle('+1 (555) 000-1111')).toBe(normalizeHandle('5550001111'));
    expect(normalizeHandle('Boardy@Example.com')).toBe('boardy@example.com');
  });
});
