import { mcpAgent } from './mcpAgent.js';

// Custom MCP servers in Gemini need the Spark tier and StreamableHTTP (which /mcp serves).
export const gemini = mcpAgent(
  'gemini',
  'Gemini',
  'General assistant used for studying and research. Reads the shared situation at the start of each chat.',
);
