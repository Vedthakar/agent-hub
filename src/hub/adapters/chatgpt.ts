import { mcpAgent } from './mcpAgent.js';

// Developer Mode MCP connectors only run on ChatGPT web, not mobile.
export const chatgpt = mcpAgent(
  'chatgpt',
  'ChatGPT',
  'General assistant used for studying and research. Reads the shared situation at the start of each chat (web only).',
);
