import { describe, expect, it } from 'vitest';
import { checkDelivery, sensitiveTopicsIn } from '../../src/hub/guard.js';
import { DEFAULT_SCOPES, canSee, type Scope } from '../../src/hub/scopes.js';
import { AGENT_IDS, TOPICS, type AgentId } from '../../src/shared/types.js';

const scope = (agent: AgentId): Scope => ({ agent, ...DEFAULT_SCOPES[agent] });

describe('canSee: full agent × topic matrix for the v1 defaults', () => {
  const allowed: Record<AgentId, string[]> = {
    claude: [...TOPICS],
    chatgpt: [...TOPICS],
    gemini: [...TOPICS],
    instinct: [...TOPICS],
    boardy: ['professional', 'networking'],
    stanley: ['content', 'shoots'],
    grok: ['work', 'open_source'],
  };
  for (const agent of AGENT_IDS) {
    it(`${agent} sees exactly ${allowed[agent].length === TOPICS.length ? 'everything' : allowed[agent].join(' + ')}`, () => {
      const seen = TOPICS.filter((t) => canSee(scope(agent), [t]));
      expect(seen).toEqual(TOPICS.filter((t) => allowed[agent].includes(t)));
    });
  }

  it('deny wins over allow when an item carries both', () => {
    for (const denied of ['school', 'health', 'finances', 'personal']) {
      expect(canSee(scope('boardy'), ['networking', denied])).toBe(false);
      expect(canSee(scope('stanley'), ['shoots', denied])).toBe(false);
      expect(canSee(scope('grok'), ['work', denied])).toBe(false);
    }
  });

  it('untagged means general, which only wildcard agents see; disabled agents see nothing', () => {
    expect(AGENT_IDS.filter((a) => canSee(scope(a), []))).toEqual(['claude', 'chatgpt', 'gemini', 'instinct']);
    expect(canSee({ ...scope('claude'), enabled: false }, ['general'])).toBe(false);
    expect(canSee(undefined, ['general'])).toBe(false);
  });
});

describe('sensitive-keyword guard', () => {
  it.each([
    ['school', 'I have a midterm on Friday'],
    ['school', 'skipping my morning class'],
    ['school', 'study session for linear algebra'],
    ['school', 'office hours with the professor'],
    ['health', 'physio says no running'],
    ['health', 'my knee is swollen'],
    ['health', 'refill my ADHD meds'],
    ['finances', 'paying rent on the 1st'],
    ['finances', 'my student loans'],
    ['finances', 'credit card bill'],
    ['personal', 'dinner with my girlfriend'],
    ['personal', "my parents' anniversary"],
    ['personal', 'going through a break up'],
  ])('flags %s in "%s"', (topic, text) => {
    expect(sensitiveTopicsIn(text)).toContain(topic);
  });

  it.each([
    'a world-class founder in climate',
    'of course, happy to intro',
    'they raised venture debt last year',
    'great at customer relationships',
    'a family office investing in seed',
    'classify the issues by label',
    'the coursera API changed',
    'rental car for the shoot',
  ])('does not flag professional phrasing: "%s"', (text) => {
    expect(sensitiveTopicsIn(text)).toEqual([]);
  });
});

describe('checkDelivery', () => {
  it('blocks disabled and out-of-scope agents', () => {
    expect(checkDelivery({ ...scope('boardy'), enabled: false }, 'Boardy', { payload: 'intro', topics: ['networking'] }).reason).toMatch(/disabled/);
    expect(checkDelivery(scope('boardy'), 'Boardy', { payload: 'make a video', topics: ['content'] }).reason).toMatch(/outside Boardy's scope/);
    expect(checkDelivery(undefined, 'X', { payload: 'x', topics: [] }).ok).toBe(false);
  });

  it('blocks a payload that leaks a denied category even when the tags look safe', () => {
    const r = checkDelivery(scope('boardy'), 'Boardy', { payload: "Tell them Ved can't meet before his midterm", topics: ['networking'] });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('payload mentions school, which Boardy may never receive');
    expect(checkDelivery(scope('grok'), 'Grok Bot', { payload: 'pause triage until my rent clears', topics: ['open_source'] }).reason).toMatch(/finances/);
  });

  it('lets wildcard agents receive sensitive payloads', () => {
    expect(checkDelivery(scope('instinct'), 'Instinct', { payload: 'midterm Friday, knee hurts, rent due', topics: ['school', 'health'] }).ok).toBe(true);
  });

  it('strips sensitive context lines but keeps the rest', () => {
    const r = checkDelivery(scope('stanley'), 'Stanley', { payload: 'Script for tomorrow', topics: ['content'] }, ['Shoot at 3pm', 'Midterm at 10am', 'Physio at noon', 'Batch two videos']);
    expect(r).toEqual({ ok: true, reason: null, context: ['Shoot at 3pm', 'Batch two videos'] });
  });
});
