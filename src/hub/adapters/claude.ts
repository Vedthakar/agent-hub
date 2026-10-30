import { mcpAgent } from './mcpAgent.js';

export const claude = mcpAgent(
  'claude',
  'Claude',
  'General assistant: deep work, writing, coding help, studying, planning. Reads the shared situation at the start of each chat.',
);
