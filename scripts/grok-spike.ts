/**
 * Grok Bot feasibility spike (build order step 7). Does exactly what Grok Bot would do over MCP with a
 * static token: list tools → get_situation → get_inbox → update_task on the first task.
 *
 *   HUB_URL=https://hub.example.com GROK_TOKEN=... npx tsx scripts/grok-spike.ts [--complete]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL('/mcp', process.env.HUB_URL ?? 'http://localhost:8787');
const token = process.env.GROK_TOKEN;
if (!token) {
  console.error('Set GROK_TOKEN to the grok entry of HUB_AGENT_TOKENS.');
  process.exit(1);
}

const textOf = (r: unknown) => ((r as { content?: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n');

const client = new Client({ name: 'grok-spike', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);
console.log('\n--- get_situation ---\n' + textOf(await client.callTool({ name: 'get_situation', arguments: {} })));
const inbox = await client.callTool({ name: 'get_inbox', arguments: {} });
console.log('\n--- get_inbox ---\n' + textOf(inbox));

const first = (inbox.structuredContent as { tasks?: { code: string }[] } | undefined)?.tasks?.[0];
if (first && process.argv.includes('--complete')) {
  const r = await client.callTool({ name: 'update_task', arguments: { task_code: first.code, status: 'done', result: 'spike: acknowledged' } });
  console.log('\n--- update_task ---\n' + textOf(r));
}
await client.close();
