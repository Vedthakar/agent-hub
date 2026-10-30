import type { AgentId } from '../../shared/types.js';
import type { Adapter } from './types.js';
import { claude } from './claude.js';
import { chatgpt } from './chatgpt.js';
import { gemini } from './gemini.js';
import { instinct } from './instinct.js';
import { stanley } from './stanley.js';
import { boardy } from './boardy.js';
import { grok } from './grok.js';

export const ADAPTERS: Record<AgentId, Adapter> = { claude, chatgpt, gemini, instinct, stanley, boardy, grok };

export function adapter(id: AgentId): Adapter {
  return ADAPTERS[id];
}
