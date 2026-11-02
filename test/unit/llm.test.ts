import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmError, backoffMs, createLlm, detectOllama } from '../../src/hub/llm.js';

const cfg = (provider: 'anthropic' | 'openai', timeoutMs = 1000) => ({
  provider,
  model: 'test-model',
  apiKey: 'sk-test',
  baseUrl: 'http://llm.invalid',
  debounceMs: 0,
  maxHops: 2,
  tickMs: 0,
  timeoutMs,
  maxAttempts: 3,
});

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function failure(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError);
    return e as LlmError;
  }
  throw new Error('expected a failure');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LLM client', () => {
  it('is disabled without a key or provider', () => {
    expect(createLlm({ ...cfg('anthropic'), apiKey: null })).toBeNull();
    expect(createLlm({ ...cfg('anthropic'), provider: 'none' })).toBeNull();
  });

  it('calls Anthropic and joins text blocks', async () => {
    const f = mockFetch(async () => Response.json({ content: [{ type: 'text', text: '{"a":' }, { type: 'tool_use' }, { type: 'text', text: '1}' }] }));
    expect(await createLlm(cfg('anthropic'))!.complete('sys', 'usr')).toBe('{"a":1}');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('http://llm.invalid/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'test-model', system: 'sys', messages: [{ role: 'user', content: 'usr' }] });
  });

  it('calls OpenAI in JSON mode', async () => {
    const f = mockFetch(async () => Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    expect(await createLlm(cfg('openai'))!.complete('sys', 'usr')).toBe('{"ok":true}');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('http://llm.invalid/chat/completions');
    expect(JSON.parse(init.body as string).response_format).toEqual({ type: 'json_object' });
  });

  it('times out as a retryable error', async () => {
    mockFetch((_u, init) => new Promise((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    const err = await failure(createLlm(cfg('anthropic', 50))!.complete('s', 'u'));
    expect(err.message).toBe('timeout after 50ms');
    expect(err.retryable).toBe(true);
  });

  it('treats network errors as retryable', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await failure(createLlm(cfg('openai'))!.complete('s', 'u'))).retryable).toBe(true);
  });

  it('honours retry-after on 429 (seconds and HTTP-date)', async () => {
    mockFetch(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }));
    const err = await failure(createLlm(cfg('anthropic'))!.complete('s', 'u'));
    expect(err).toMatchObject({ retryable: true, retryAfterMs: 7000 });
    expect(err.message).toBe('HTTP 429: slow down');

    mockFetch(async () => new Response('', { status: 503, headers: { 'retry-after': new Date(Date.now() + 30_000).toUTCString() } }));
    const err2 = await failure(createLlm(cfg('anthropic'))!.complete('s', 'u'));
    expect(err2.retryAfterMs).toBeGreaterThan(25_000);
    expect(err2.retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  it.each([
    [500, true],
    [502, true],
    [408, true],
    [409, true],
    [400, false],
    [401, false],
    [404, false],
  ])('HTTP %i retryable=%s', async (status, retryable) => {
    mockFetch(async () => new Response('x'.repeat(1000), { status }));
    const err = await failure(createLlm(cfg('openai'))!.complete('s', 'u'));
    expect(err.retryable).toBe(retryable);
    expect(err.message.length).toBeLessThan(320); // provider error bodies are capped
  });

  it('treats a non-JSON envelope as retryable', async () => {
    mockFetch(async () => new Response('<html>gateway</html>', { status: 200 }));
    const err = await failure(createLlm(cfg('anthropic'))!.complete('s', 'u'));
    expect(err).toMatchObject({ message: 'invalid JSON envelope from provider', retryable: true });
  });

  it('returns an empty string for an empty envelope (the router then fails extraction and retries)', async () => {
    mockFetch(async () => Response.json({}));
    expect(await createLlm(cfg('openai'))!.complete('s', 'u')).toBe('');
    expect(await createLlm(cfg('anthropic'))!.complete('s', 'u')).toBe('');
  });
});

describe('free local model (Ollama)', () => {
  it('needs no key and sends no Authorization header', async () => {
    const fetch = mockFetch(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] })));
    const llm = createLlm({ ...cfg('openai'), provider: 'ollama', apiKey: null, baseUrl: null, model: 'llama3.2' });
    expect(llm).not.toBeNull();
    expect(await llm!.complete('sys', 'user')).toBe('{"ok":true}');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(JSON.parse(String(init.body)).model).toBe('llama3.2');
  });

  it('detects an installed model, prefers the requested one, and returns null when Ollama is absent or empty', async () => {
    mockFetch(async () => new Response(JSON.stringify({ models: [{ name: 'gemma3:4b' }, { name: 'llama3.2:latest' }] })));
    expect(await detectOllama(null)).toBe('llama3.2:latest');
    expect(await detectOllama('gemma3')).toBe('gemma3:4b');
    mockFetch(async () => new Response(JSON.stringify({ models: [] })));
    expect(await detectOllama(null)).toBeNull();
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await detectOllama(null)).toBeNull();
  });
});

describe('backoffMs', () => {
  it('grows exponentially with jitter in [exp/2, exp] and respects the cap', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const exp = Math.min(60_000, 1000 * 2 ** (attempt - 1));
      for (let i = 0; i < 50; i++) {
        const v = backoffMs(attempt, 1000, 60_000);
        expect(v).toBeGreaterThanOrEqual(exp / 2);
        expect(v).toBeLessThanOrEqual(exp);
      }
    }
  });
});
