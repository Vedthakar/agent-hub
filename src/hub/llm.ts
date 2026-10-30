import type { HubConfig } from './config.js';

export interface Llm {
  /** Returns the model's raw text reply. Callers are responsible for parsing. */
  complete(system: string, user: string): Promise<string>;
}

/** Thrown for every LLM failure so the router can decide between retry-with-backoff and dead-lettering. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Server-suggested wait (429 / 503 `retry-after`). */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export function createLlm(cfg: HubConfig['router']): Llm | null {
  if (cfg.provider === 'none' || !cfg.apiKey) return null;
  if (cfg.provider === 'anthropic') return anthropic(cfg.apiKey, cfg.model, cfg.baseUrl ?? 'https://api.anthropic.com', cfg.timeoutMs);
  return openai(cfg.apiKey, cfg.model, cfg.baseUrl ?? 'https://api.openai.com/v1', cfg.timeoutMs);
}

function retryAfter(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error).name;
    throw new LlmError(name === 'TimeoutError' || name === 'AbortError' ? `timeout after ${timeoutMs}ms` : `network: ${(err as Error).message}`, true);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
    throw new LlmError(`HTTP ${res.status}: ${detail}`, retryable, retryAfter(res));
  }
  try {
    return await res.json();
  } catch {
    throw new LlmError('invalid JSON envelope from provider', true);
  }
}

function anthropic(apiKey: string, model: string, baseUrl: string, timeoutMs: number): Llm {
  return {
    async complete(system, user) {
      const body = (await post(
        `${baseUrl}/v1/messages`,
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] },
        timeoutMs,
      )) as { content?: { type: string; text?: string }[] };
      return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    },
  };
}

function openai(apiKey: string, model: string, baseUrl: string, timeoutMs: number): Llm {
  return {
    async complete(system, user) {
      const body = (await post(
        `${baseUrl}/chat/completions`,
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        timeoutMs,
      )) as { choices?: { message: { content: string } }[] };
      return body.choices?.[0]?.message.content ?? '';
    },
  };
}

/** Pulls the first JSON object out of a model reply (tolerates code fences / prose around it). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new LlmError('no JSON object in model reply', true);
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    throw new LlmError(`malformed JSON in model reply: ${(err as Error).message}`, true);
  }
}

/** Exponential backoff with jitter, capped. attempt is 1-based. */
export function backoffMs(attempt: number, baseMs: number, capMs = 60 * 60_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}
